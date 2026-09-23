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
