'use strict';

/**
 * Dahua DHIP-Protokoll-Client für VTO-Türstationen und VTH-Innenmonitore.
 *
 * Implementiert das binäre DHIP-Framing über TCP (Standardport 5000):
 *   Header (32 Byte, little endian):
 *     [0..8)   uint64 Protokoll-ID 0x5049484400000020
 *     [8..12)  uint32 Session-ID
 *     [12..16) uint32 Nachrichten-ID (Request-Sequenz)
 *     [16..24) uint64 Länge des JSON-Body
 *     [24..32) uint64 Länge des JSON-Body (wiederholt)
 *   gefolgt vom kompakt serialisierten JSON-Body.
 *
 * Login-Flow ("Direct"):
 *   1. global.login ohne Anmeldedaten -> Fehlercode 268632079 liefert realm + random
 *   2. hash1 = MD5_UPPER(userName:realm:password)
 *      hash2 = MD5_UPPER(userName:random:hash1)
 *   3. global.login mit userName und hash2 als Passwort -> session, keepAliveInterval
 *
 * Ereignisse werden per eventManager.attach (codes: ["All"]) abonniert und
 * treffen als client.notifyEventStream-Nachrichten mit params.eventList ein.
 *
 * Die Protokoll-Implementierung folgt dem Vorbild des Open-Source-Projekts
 * myhomeiot/DahuaVTO (GPL-3.0), https://github.com/myhomeiot/DahuaVTO
 */

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const DHIP_PROTOCOL_ID = 0x5049484400000020n;
const DHIP_HEADER_LENGTH = 32;
const DHUA_REALM_ERROR = 268632079;
const DEFAULT_KEEPALIVE_INTERVAL = 60;
const MIN_RECONNECT_INTERVAL = 1;

/**
 * Baut den DHIP-Rahmen (Header + Body) für eine Nachricht.
 * @param {number} sessionId - Session-ID (0 vor dem Login)
 * @param {number} messageId - Sequenz-ID der Nachricht
 * @param {object} message - JSON-Nachricht ohne id
 * @returns {Buffer} Rahmen inkl. 32-Byte-Header
 */
function buildFrame(sessionId, messageId, message) {
    const body = Buffer.from(JSON.stringify({ ...message, id: messageId }), 'utf8');
    const header = Buffer.alloc(DHIP_HEADER_LENGTH);
    header.writeBigUInt64LE(DHIP_PROTOCOL_ID, 0);
    header.writeUInt32LE(sessionId >>> 0, 8);
    header.writeUInt32LE(messageId >>> 0, 12);
    header.writeBigUInt64LE(BigInt(body.length), 16);
    header.writeBigUInt64LE(BigInt(body.length), 24);
    return Buffer.concat([header, body]);
}

/**
 * Berechnet das Dahua-Direct-Login-Passwort.
 * @param {string} username
 * @param {string} realm - realm aus der ersten Login-Antwort
 * @param {string} random - random aus der ersten Login-Antwort
 * @param {string} password - Klartextpasswort
 * @returns {string} MD5(userName:random:MD5(userName:realm:password)), Großbuchstaben
 */
function hashDahuaPassword(username, realm, random, password) {
    const hash1 = crypto
        .createHash('md5')
        .update(`${username}:${realm}:${password}`, 'utf8')
        .digest('hex')
        .toUpperCase();
    return crypto
        .createHash('md5')
        .update(`${username}:${random}:${hash1}`, 'utf8')
        .digest('hex')
        .toUpperCase();
}

class DahuaClient extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.host - IP/Hostname der Türkommunikation
     * @param {number} [options.port=5000] - TCP-Port
     * @param {string} options.username - Benutzername (Standard: admin)
     * @param {string} options.password - Passwort
     * @param {number} [options.reconnectInterval=30] - Sekunden zwischen Verbindungsversuchen
     * @param {number} [options.requestTimeout=10] - Sekunden bis eine Anfrage abbricht
     * @param {object} [options.log] - ioBroker-Logobjekt (debug/info/warn/error)
     */
    constructor(options = {}) {
        super();
        this.host = options.host;
        this.port = Number.isFinite(options.port) ? options.port : 5000;
        this.username = options.username || 'admin';
        this.password = options.password || '';
        this.reconnectInterval = Math.max(MIN_RECONNECT_INTERVAL, options.reconnectInterval || 30);
        this.requestTimeout = Math.max(1, options.requestTimeout || 10);
        this.log = options.log || console;

        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.sessionId = 0;
        this.requestId = 0;
        this.loginPhase = 0;
        this.pendingLoginId = null;
        this.loggedIn = false;
        this.destroyed = false;
        this.keepAliveInterval = DEFAULT_KEEPALIVE_INTERVAL;
        this.keepAliveTimer = null;
        this.reconnectTimer = null;
        this.pending = new Map(); // messageId -> { resolve, reject, timer }
    }

    /** Baut die TCP-Verbindung auf (bricht alte Reste ab). */
    connect() {
        this.destroyed = false;
        this._connectSocket();
    }

    /** Trennt endgültig und räumt Timer/Pendings auf. */
    destroy() {
        this.destroyed = true;
        this._clearTimers();
        this._rejectAllPending('Verbindung wurde geschlossen');
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
    }

    _connectSocket() {
        if (this.destroyed) {
            return;
        }
        this._resetSession();
        this.socket = net.createConnection({ host: this.host, port: this.port });
        this.socket.setKeepAlive(true, 30_000);

        this.socket.on('connect', () => {
            this.log.debug && this.log.debug(`TCP-Verbindung zu ${this.host}:${this.port} hergestellt`);
            this._startLogin();
        });
        this.socket.on('data', (chunk) => this._onData(chunk));
        this.socket.on('error', (err) => {
            // 'close' folgt immer; hier nur melden
            this.emit('error', err);
        });
        this.socket.on('close', () => this._onClose());
    }

    _resetSession() {
        this.buffer = Buffer.alloc(0);
        this.sessionId = 0;
        this.loginPhase = 0;
        this.pendingLoginId = null;
        this.loggedIn = false;
        this._stopKeepAlive();
        this._rejectAllPending('Verbindung wurde zurückgesetzt');
    }

    _startLogin() {
        this.loginPhase = 1;
        this.pendingLoginId = this._send({
            method: 'global.login',
            params: { clientType: '', ipAddr: '(null)', loginType: 'Direct' },
        });
    }

    _handleLoginResponse(message) {
        if (this.loginPhase === 1) {
            const { random, realm } = message.params || {};
            const code = message.error && message.error.code;
            if (code !== DHUA_REALM_ERROR || !random || !realm) {
                this._fail(`Unerwartete Antwort auf den ersten Login: ${JSON.stringify(message.error || message)}`);
                return;
            }
            if (typeof message.session === 'number') {
                this.sessionId = message.session;
            }
            this.loginPhase = 2;
            this.pendingLoginId = this._send({
                method: 'global.login',
                params: {
                    userName: this.username,
                    password: hashDahuaPassword(this.username, realm, random, this.password),
                    clientType: '',
                    ipAddr: '(null)',
                    loginType: 'Direct',
                },
            });
            return;
        }

        if (message.error) {
            this._fail(`Anmeldung fehlgeschlagen: ${JSON.stringify(message.error)} (Benutzername/Passwort prüfen)`);
            return;
        }

        if (typeof message.session === 'number') {
            this.sessionId = message.session;
        }
        const interval = message.params && message.params.keepAliveInterval;
        this.keepAliveInterval = interval > 0 ? interval : DEFAULT_KEEPALIVE_INTERVAL;
        this.pendingLoginId = null;
        this.loggedIn = true;
        this._startKeepAlive();
        this.request({ method: 'eventManager.attach', params: { codes: ['All'] } }).catch((err) => {
            this.log.warn && this.log.warn(`Ereignis-Abonnement fehlgeschlagen: ${err.message}`);
        });
        this.emit('connected');
    }

    /**
     * Sendet eine JSON-RPC-Anfrage und wartet auf die Antwort.
     * @param {object} payload - Nachricht ohne id (method/object/params)
     * @returns {Promise<object>} Antwortnachricht (enthält result oder error)
     */
    request(payload) {
        return new Promise((resolve, reject) => {
            if (this.destroyed) {
                reject(new Error('Client wurde zerstört'));
                return;
            }
            if (!this.loggedIn && payload.method !== 'global.login') {
                reject(new Error('Nicht angemeldet'));
                return;
            }
            const id = this._send(payload);
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Timeout (${this.requestTimeout} s) bei Anfrage ${payload.method}`));
            }, this.requestTimeout * 1000);
            this.pending.set(id, { resolve, reject, timer });
        });
    }

    /** Liest Geräteinformationen (deviceType, serialNumber, ...). */
    getSystemInfo() {
        return this.request({ method: 'magicBox.getSystemInfo' });
    }

    /**
     * Löst den Türöffner aus. Legt dazu temporär eine accessControl-Instanz an
     * (Dahua-Instanzmuster: factory.instance -> openDoor -> destroy).
     * @param {number} [channel=1] - Türkanal (1-basiert, wird auf 0-basiert umgerechnet)
     * @param {number} [doorIndex=0] - DoorIndex-Parameter des Geräts
     * @param {number} [shortNumber=1] - ShortNumber-Parameter des Geräts
     */
    async openDoor(channel = 1, doorIndex = 0, shortNumber = 1) {
        const instance = await this.request({
            method: 'accessControl.factory.instance',
            params: { channel: channel - 1 },
        });
        const objectId =
            typeof instance?.result === 'object' && instance.result !== null
                ? instance.result.object ?? instance.result
                : instance?.result;
        try {
            return await this.request({
                method: 'accessControl.openDoor',
                object: objectId,
                params: { DoorIndex: doorIndex, ShortNumber: shortNumber },
            });
        } finally {
            await this.request({ method: 'accessControl.destroy', object: objectId }).catch(() => {
                // Instanz konnte nicht abgeräumt werden – ignoriert das Gerät sie später selbst
            });
        }
    }

    /** Sendet eine Nachricht und liefert die vergebene Nachrichten-ID zurück. */
    _send(message) {
        this.requestId += 1;
        const frame = buildFrame(this.sessionId, this.requestId, message);
        if (this.socket) {
            this.socket.write(frame);
        }
        return this.requestId;
    }

    _onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            if (this.buffer.length < DHIP_HEADER_LENGTH) {
                return;
            }
            const proto = this.buffer.readBigUInt64LE(0);
            if (proto !== DHIP_PROTOCOL_ID) {
                this._fail('Protokollfehler: ungültiger DHIP-Header (Byte-Synchronisation verloren)');
                return;
            }
            const dataLen = Number(this.buffer.readBigUInt64LE(16));
            const dataLen2 = Number(this.buffer.readBigUInt64LE(24));
            if (dataLen !== dataLen2) {
                this._fail('Protokollfehler: inkonsistente Längenfelder im DHIP-Header');
                return;
            }
            const total = DHIP_HEADER_LENGTH + dataLen;
            if (this.buffer.length < total) {
                return; // auf den Rest des Rahmens warten
            }
            const body = this.buffer.subarray(DHIP_HEADER_LENGTH, total);
            this.buffer = this.buffer.subarray(total);
            if (body.length === 0) {
                continue;
            }
            let message;
            try {
                message = JSON.parse(body.toString('utf8'));
            } catch {
                this.log.warn && this.log.warn(`Ungültige JSON-Nachricht empfangen (${body.length} Byte)`);
                continue;
            }
            this._handleMessage(message);
        }
    }

    _handleMessage(message) {
        // Benachrichtigungen (Events) haben eine method- und keine offene Anfrage-ID
        if (typeof message.method === 'string' && message.method.startsWith('client.notify')) {
            this._handleNotification(message);
            return;
        }

        if (this.pendingLoginId !== null && message.id === this.pendingLoginId) {
            this._handleLoginResponse(message);
            return;
        }

        const pending = this.pending.get(message.id);
        if (pending) {
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.error) {
                pending.reject(new Error(`${message.error.code ?? ''} ${message.error.message ?? ''}`.trim()));
            } else {
                pending.resolve(message);
            }
        }
    }

    _handleNotification(message) {
        if (message.method === 'client.notifyEventStream') {
            const eventList = message.params && message.params.eventList;
            if (Array.isArray(eventList)) {
                for (const event of eventList) {
                    this.emit('event', event);
                }
            }
        } else if (message.method === 'client.notifyConfigChange') {
            this.log.debug && this.log.debug('Konfigurationsänderung am Gerät gemeldet');
        }
    }

    _startKeepAlive() {
        this._stopKeepAlive();
        this.keepAliveTimer = setInterval(() => {
            this.request({ method: 'global.keepAlive', params: { timeout: this.keepAliveInterval, action: true } }).catch(
                (err) => {
                    this.log.debug && this.log.debug(`keepAlive fehlgeschlagen: ${err.message}`);
                    this._reconnectAfterFailure();
                },
            );
        }, this.keepAliveInterval * 1000);
        if (typeof this.keepAliveTimer.unref === 'function') {
            this.keepAliveTimer.unref();
        }
    }

    _stopKeepAlive() {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    _reconnectAfterFailure() {
        if (this.socket) {
            this.socket.destroy(); // löst 'close' -> Reconnect aus
        } else {
            this._onClose();
        }
    }

    _onClose() {
        const wasLoggedIn = this.loggedIn;
        this._resetSession();
        if (this.destroyed) {
            return;
        }
        if (wasLoggedIn) {
            this.emit('disconnected');
        }
        this._scheduleReconnect();
    }

    _scheduleReconnect() {
        if (this.destroyed || this.reconnectTimer) {
            return;
        }
        this.log.info && this.log.info(`Neuer Verbindungsversuch in ${this.reconnectInterval} s`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this._connectSocket();
        }, this.reconnectInterval * 1000);
    }

    _fail(reason) {
        this.log.error && this.log.error(reason);
        this._reconnectAfterFailure();
    }

    _clearTimers() {
        this._stopKeepAlive();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    _rejectAllPending(reason) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(reason));
        }
        this.pending.clear();
    }
}

module.exports = {
    DahuaClient,
    buildFrame,
    hashDahuaPassword,
    DHIP_PROTOCOL_ID,
    DHIP_HEADER_LENGTH,
    DHUA_REALM_ERROR,
};
