'use strict';

/*
 * ioBroker-Adapter für Dahua VTO (Türstation) und VTH (Innenmonitor)
 *
 * Basierend auf dem DHIP-Protokoll; Protokoll-Vorbild:
 * myhomeiot/DahuaVTO (GPL-3.0), https://github.com/myhomeiot/DahuaVTO
 */

const utils = require('@iobroker/adapter-core');
const { DahuaClient } = require('./lib/dahuaClient');

/** Wie lange der Klingel-Trigger auf true bleibt, bevor er zurückgesetzt wird. */
const DOORBELL_RESET_MS = 1000;

/** Zeichensetzung in Event-Codes, die keine gültigen ioBroker-IDs sind. */
const UNSAFE_ID_CHARS = /[^A-Za-z0-9_-]/g;

const DEFAULT_DOORBELL_EVENT_CODES = ['BackKeyLight', 'AlarmLocal'];

class DahuaVto extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    constructor(options) {
        super({
            ...options,
            name: 'dahua-vto',
        });
        this.client = null;
        this.doorbellCodes = [];
        this.eventCodeCache = new Set();
        this.doorbellResetTimer = null;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('fileError', this.onFileError.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        if (!this.config.host) {
            this.log.error(
                'Kein Host konfiguriert. Bitte in den Instanz-Einstellungen die IP-Adresse bzw. den Hostnamen der Türkommunikation eintragen.',
            );
            this.setState('info.connection', false, true);
            return;
        }

        this.doorbellCodes = this._parseDoorbellCodes(this.config.doorbellEventCodes);
        this.log.debug(
            `Klingel-Trigger für Ereignis-Codes: ${this.doorbellCodes.join(', ') || '(keine)'}`,
        );

        this.subscribeStates('door.open');

        this.client = new DahuaClient({
            host: this.config.host,
            port: this.config.port,
            username: this.config.username,
            password: this.config.password,
            reconnectInterval: this.config.reconnectInterval,
            requestTimeout: this.config.requestTimeout,
            log: this.log,
        });

        this.client
            .on('connected', () => this._onConnected())
            .on('disconnected', () => this._onDisconnected())
            .on('event', (event) => this._onEvent(event))
            .on('error', (err) => this.log.warn(`Verbindungsfehler: ${err.message}`));

        this.client.connect();
    }

    /**
     * Nach erfolgreicher Anmeldung: Verbindungsstatus setzen und Geräteinfos lesen.
     */
    async _onConnected() {
        this.setState('info.connection', true, true);
        this.log.info(`Angemeldet an ${this.config.host}:${this.config.port}`);

        try {
            const response = await this.client.getSystemInfo();
            const info = response && response.result;
            if (info && typeof info === 'object') {
                if (typeof info.deviceType === 'string' && info.deviceType) {
                    await this.setStateChangedAsync('device.deviceType', info.deviceType, true);
                }
                if (typeof info.serialNumber === 'string' && info.serialNumber) {
                    await this.setStateChangedAsync('device.serialNumber', info.serialNumber, true);
                }
                await this.setStateChangedAsync('device.systemInfo', JSON.stringify(info), true);
                this.log.info(`Gerät: ${info.deviceType ?? 'unbekannt'} (SN ${info.serialNumber ?? 'unbekannt'})`);
            }
        } catch (err) {
            this.log.warn(`Systeminformationen konnten nicht gelesen werden: ${err.message}`);
        }

        this.eventCodeCache.clear();
    }

    _onDisconnected() {
        this.setState('info.connection', false, true);
        this.log.warn(`Verbindung zu ${this.config.host} verloren – neuer Versuch laufend`);
    }

    /**
     * Verarbeitet ein Dahua-Ereignis aus dem Event-Stream.
     * @param {object} event - z. B. { Code: 'BackKeyLight', Data: { Stat: true } }
     */
    async _onEvent(event) {
        const code = String(event?.Code ?? event?.code ?? 'Unknown');
        const data = event?.Data ?? event?.data ?? {};
        this.log.debug(`Ereignis ${code}: ${JSON.stringify(data)}`);

        this.setStateChangedAsync('events.lastEvent.code', code, true);
        this.setStateChangedAsync('events.lastEvent.data', JSON.stringify(data), true);
        this.setStateChangedAsync('events.lastEvent.time', new Date().toISOString(), true);

        if (this.config.createEventStates) {
            await this._updateEventState(code, data);
        }

        if (code === 'DoorStatus') {
            const status = data.Status ?? data.status;
            if (status !== undefined) {
                const open = status === 'Open' || status === true || status === 1;
                await this.setStateChangedAsync('door.status', open, true);
            }
        }

        if (this.doorbellCodes.includes(code)) {
            await this._triggerDoorbell(code, data);
        }
    }

    /**
     * Legt (einmalig) einen Datenpunkt pro Ereignis-Code an und aktualisiert ihn.
     */
    async _updateEventState(code, data) {
        const stateId = `events.${code.replace(UNSAFE_ID_CHARS, '_')}`;
        if (!this.eventCodeCache.has(stateId)) {
            await this.extendObjectAsync(stateId, {
                type: 'state',
                common: {
                    name: `Ereignis ${code}`,
                    type: 'string',
                    role: 'json',
                    read: true,
                    write: false,
                    desc: `Daten (JSON) des Dahua-Ereignisses ${code}`,
                },
                native: { code },
            });
            this.eventCodeCache.add(stateId);
        }
        await this.setStateAsync(stateId, JSON.stringify(data), true);
    }

    /**
     * Setzt den Klingel-Trigger und setzt ihn nach kurzer Zeit zurück.
     */
    async _triggerDoorbell(code, data) {
        this.log.info(`Klingel-Ereignis ausgelöst (${code}): ${JSON.stringify(data)}`);
        await this.setStateAsync('doorbell.trigger', true, true);
        await this.setStateAsync('doorbell.code', code, true);
        if (this.doorbellResetTimer) {
            clearTimeout(this.doorbellResetTimer);
        }
        this.doorbellResetTimer = setTimeout(async () => {
            this.doorbellResetTimer = null;
            try {
                await this.setStateAsync('doorbell.trigger', false, true);
            } catch {
                // Instanz kann bereits entladen sein
            }
        }, DOORBELL_RESET_MS);
    }

    /**
     * Is called if a subscribed state changes.
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        if (id === `${this.namespace}.door.open` && state.val) {
            try {
                await this.client.openDoor(
                    this.config.channel,
                    this.config.doorIndex,
                    this.config.shortNumber,
                );
                this.log.info('Türöffner ausgelöst');
                await this.setStateAsync(id, state.val, true);
            } catch (err) {
                this.log.error(`Türöffner konnte nicht ausgelöst werden: ${err.message}`);
            }
        }
    }

    /**
     * Some message was printed to console and needs to be handled by the adapter.
     * @param {string} _id
     * @param {string} _text
     */
    onFileError(_id, _text) {
        this.log.error(`onFileError: ${_text}`);
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances.
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            if (this.doorbellResetTimer) {
                clearTimeout(this.doorbellResetTimer);
            }
            if (this.client) {
                this.client.destroy();
            }
            this.setState('info.connection', false, true);
            callback();
        } catch {
            callback();
        }
    }

    /**
     * @param {string} raw - kommagetrennte Liste von Ereignis-Codes
     * @returns {string[]}
     */
    _parseDoorbellCodes(raw) {
        const codes = String(raw || '')
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
        return codes.length > 0 ? codes : [...DEFAULT_DOORBELL_EVENT_CODES];
    }
}

if (require.main === module) {
    // Export the constructor in compact mode
    module.exports = (options) => new DahuaVto(options);
} else {
    // Otherwise start the instance directly
    new DahuaVto();
}
