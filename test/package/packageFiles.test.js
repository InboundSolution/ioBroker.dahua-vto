'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..', '..');

describe('io-package.json / package.json Konsistenz', () => {
    const ioPackage = JSON.parse(fs.readFileSync(path.join(rootDir, 'io-package.json'), 'utf8'));
    const npmPackage = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

    it('npm-Paketname passt zum Adapternamen', () => {
        expect(npmPackage.name).to.equal(`iobroker.${ioPackage.common.name}`);
    });

    it('Versionen sind synchron', () => {
        expect(npmPackage.version).to.equal(ioPackage.common.version);
    });

    it('Adapter läuft als Daemon mit JSON-Config', () => {
        expect(ioPackage.common.mode).to.equal('daemon');
        expect(ioPackage.common.adminUI.config).to.equal('json');
        expect(fs.existsSync(path.join(rootDir, 'admin', 'jsonConfig.json'))).to.be.true;
    });

    it('Konfigurationsfelder besitzen Einträge in native', () => {
        for (const key of [
            'host',
            'port',
            'username',
            'password',
            'channel',
            'doorIndex',
            'shortNumber',
            'reconnectInterval',
            'requestTimeout',
            'doorbellEventCodes',
            'createEventStates',
        ]) {
            expect(ioPackage.native).to.have.property(key);
        }
    });

    it('Haupteinstiegspunkt existiert', () => {
        expect(fs.existsSync(path.join(rootDir, npmPackage.main))).to.be.true;
    });

    it('englische und deutsche Übersetzungen decken die jsonConfig ab', () => {
        const jsonConfig = JSON.parse(fs.readFileSync(path.join(rootDir, 'admin', 'jsonConfig.json'), 'utf8'));
        for (const lang of ['de', 'en']) {
            const translations = JSON.parse(
                fs.readFileSync(path.join(rootDir, 'admin', 'i18n', lang, 'translations.json'), 'utf8'),
            );
            const collectKeys = (items) => {
                const keys = [];
                for (const value of Object.values(items || {})) {
                    for (const prop of ['title', 'text', 'label', 'help']) {
                        if (typeof value[prop] === 'string') {
                            keys.push(value[prop]);
                        }
                    }
                    if (value.items) {
                        keys.push(...collectKeys(value.items));
                    }
                }
                return keys;
            };
            const missing = collectKeys(jsonConfig.items).filter(
                (key) => /^[a-z][a-zA-Z0-9]*$/.test(key) && !translations[key],
            );
            expect(missing, `fehlende ${lang}-Übersetzungen: ${missing.join(', ')}`).to.be.an('array').that.is.empty;
        }
    });
});
