'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
const {
    DahuaClient,
    buildFrame,
    hashDahuaPassword,
    DHIP_PROTOCOL_ID,
    DHIP_HEADER_LENGTH,
} = require('../../lib/dahuaClient');

const md5Upper = (value) =>
    crypto.createHash('md5').update(value, 'utf8').digest('hex').toUpperCase();

describe('lib/dahuaClient buildFrame', () => {
    it('erzeugt einen 32-Byte-Header mit Protokoll-ID, Session, ID und Länge', () => {
        const message = { method: 'global.login', params: { loginType: 'Direct' } };
        const frame = buildFrame(5, 42, message);
        expect(frame.length).to.equal(DHIP_HEADER_LENGTH + Buffer.byteLength(JSON.stringify({ ...message, id: 42 })));
        expect(frame.readBigUInt64LE(0)).to.equal(DHIP_PROTOCOL_ID);
        expect(frame.readUInt32LE(8)).to.equal(5);
        expect(frame.readUInt32LE(12)).to.equal(42);
        expect(Number(frame.readBigUInt64LE(16))).to.equal(frame.length - DHIP_HEADER_LENGTH);
        expect(Number(frame.readBigUInt64LE(24))).to.equal(frame.length - DHIP_HEADER_LENGTH);
    });

    it('betten die Nachricht mit vergebener id als kompaktes JSON ein', () => {
        const body = JSON.parse(buildFrame(0, 7, { method: 'magicBox.getSystemInfo' }).subarray(DHIP_HEADER_LENGTH).toString('utf8'));
        expect(body).to.deep.equal({ method: 'magicBox.getSystemInfo', id: 7 });
    });
});

describe('lib/dahuaClient hashDahuaPassword', () => {
    it('berechnet MD5(userName:random:MD5(userName:realm:password)) in Großbuchstaben', () => {
        const username = 'admin';
        const password = 'secret';
        const realm = 'hid_4f0a7c3e';
        const random = '1478523690123456';
        const hash1 = md5Upper(`${username}:${realm}:${password}`);
        const expected = md5Upper(`${username}:${random}:${hash1}`);
        expect(hashDahuaPassword(username, realm, random, password)).to.equal(expected);
        expect(hashDahuaPassword(username, realm, random, password)).to.match(/^[0-9A-F]{32}$/);
    });
});

describe('lib/dahuaClient Login-Flow', () => {
    const buildResponse = (payload, sessionId) => {
        const body = Buffer.from(JSON.stringify(payload), 'utf8');
        const header = Buffer.alloc(DHIP_HEADER_LENGTH);
        header.writeBigUInt64LE(DHIP_PROTOCOL_ID, 0);
        header.writeUInt32LE(sessionId >>> 0, 8);
        header.writeUInt32LE(0, 12);
        header.writeBigUInt64LE(BigInt(body.length), 16);
        header.writeBigUInt64LE(BigInt(body.length), 24);
        return Buffer.concat([header, body]);
    };

    it('trägt session im JSON-Body und hasht das Passwort für den zweiten Login', () => {
        const client = new DahuaClient({
            host: '1.2.3.4',
            username: 'admin',
            password: 'secret',
            log: { debug() {}, info() {}, warn() {}, error() {} },
        });
        const written = [];
        client.socket = { write: (frame) => written.push(frame), destroy() {}, setKeepAlive() {} };
        let connected = 0;
        client.on('connected', () => {
            connected += 1;
        });

        client._startLogin();
        const first = JSON.parse(written[0].subarray(DHIP_HEADER_LENGTH).toString('utf8'));
        expect(first.method).to.equal('global.login');
        expect(first.session).to.equal(0);

        client._onData(
            buildResponse(
                {
                    error: { code: 268632079, message: 'UnAuthorized' },
                    id: first.id,
                    params: { realm: 'hid_test', random: '1234567890', encryption: 'MD5' },
                    session: 0,
                },
                0,
            ),
        );

        const second = JSON.parse(written[1].subarray(DHIP_HEADER_LENGTH).toString('utf8'));
        expect(second.method).to.equal('global.login');
        expect(second.session).to.equal(0);
        expect(second.params.userName).to.equal('admin');
        expect(second.params.password).to.equal(hashDahuaPassword('admin', 'hid_test', '1234567890', 'secret'));

        client._onData(
            buildResponse(
                { id: second.id, result: 0, session: 7, params: { keepAliveInterval: 60 } },
                7,
            ),
        );

        // Nach dem Login laufen Folgeanfragen mit der zugewiesenen Session im Body
        const third = JSON.parse(written[2].subarray(DHIP_HEADER_LENGTH).toString('utf8'));
        expect(third.method).to.equal('eventManager.attach');
        expect(third.session).to.equal(7);
        expect(connected).to.equal(1);

        client.destroy();
    });
});

describe('lib/dahuaClient frame parsing', () => {
    it('zerlegt aneinandergehängte Rahmen inkl. TCP-Fragmentierung', () => {
        const client = new DahuaClient({ host: '1.2.3.4', log: { debug() {}, info() {}, warn() {}, error() {} } });
        const events = [];
        client.on('event', (event) => events.push(event));

        const eventMessage = Buffer.from(
            JSON.stringify({
                method: 'client.notifyEventStream',
                params: { eventList: [{ Code: 'BackKeyLight', Data: { Stat: true } }] },
            }),
            'utf8',
        );
        const header = Buffer.alloc(DHIP_HEADER_LENGTH);
        header.writeBigUInt64LE(DHIP_PROTOCOL_ID, 0);
        header.writeUInt32LE(1, 8);
        header.writeUInt32LE(0, 12);
        header.writeBigUInt64LE(BigInt(eventMessage.length), 16);
        header.writeBigUInt64LE(BigInt(eventMessage.length), 24);
        const frame = Buffer.concat([header, eventMessage]);

        // In zwei Häften zustellen, wie es TCP macht
        client._onData(frame.subarray(0, 20));
        client._onData(frame.subarray(20));
        client.destroy();

        expect(events).to.have.lengthOf(1);
        expect(events[0].Code).to.equal('BackKeyLight');
        expect(events[0].Data).to.deep.equal({ Stat: true });
    });

    it('verwirft ungültige Protokoll-Header und baut die Verbindung ab', () => {
        const client = new DahuaClient({ host: '1.2.3.4', log: { debug() {}, info() {}, warn() {}, error() {} } });
        let closed = false;
        // Socket simulieren: destroy markiert das Schließen
        client.socket = { destroy: () => { closed = true; client._onClose(); }, write() {}, setKeepAlive() {} };
        client._onData(Buffer.from('kein gueltiges DHIP'.padEnd(64, '#'), 'utf8'));
        client.destroy();
        expect(closed).to.be.true;
    });
});
