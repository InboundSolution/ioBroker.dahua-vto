# ioBroker.dahua-vto

![Version](https://img.shields.io/badge/version-0.0.1-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

## Dahua VTO/VTH Gegensprechanlage für ioBroker

Dieser Adapter bindet **Dahua Türkommunikation** (Außenstationen der Serien **VTO** und Innenmonitore **VTH**) direkt über das Netzwerk in ioBroker ein – nach dem Vorbild des Open-Source-Projekts [myhomeiot/DahuaVTO](https://github.com/myhomeiot/DahuaVTO).

Der Adapter verbindet sich per TCP (Standardport **5000**) mit dem Gerät, meldet sich über das DHIP-Protokoll an und abonniert den Ereignis-Stream. Daraus entstehen ioBroker-Datenpunkte für Klingel, Anruf und Türstatus; zusätzlich lässt sich der Türöffner aus ioBroker heraus auslösen.

### Features

- 🔔 **Klingel-/Anruf-Trigger**: Reagiert auf Ereignisse wie `BackKeyLight` (VTH), `AlarmLocal` (Klingeltaste an der VTO) oder `CallDlgStatus` (Anrufstatus) – konfigurierbar
- 🚪 **Türöffner schalten**: Datenpunkt `door.open` löst den Türöffner am Gerät aus
- 📡 **Alle Ereignisse**: Für jeden empfangenen Ereignis-Code wird optional automatisch ein Datenpunkt `events.<Code>` angelegt (JSON-Daten)
- 🔁 **Robust**: Automatische Wiederverbindung, Keep-Alive-Überwachung, Anfrage-Timeouts
- 🇩🇪 Deutsche Admin-Oberfläche (Englisch ebenfalls verfügbar)

### Getestete Geräte (Reported Working,Stand Vorbild-Projekt)

VTO2000, VTO2101, VTO2111, VTO2202, VTO2211, VTO3211, VTO3221, VTO4202, VTO9541D sowie VTH1550, VTH2421, VTH5221. Weitere Modelle mit DHIP-Schnittstelle (Port 5000) sollten ebenfalls funktionieren.

## Installation

### Vorbereitung am Gerät

1. Am Dahua-Gerät (z. B. über das Web-Interface der Türkommunikation) einen **lokalen Admin-Benutzer** anlegen oder den vorhandenen `admin`-Zugang nutzen.
2. Sicherstellen, dass das Gerät über das Netzwerk erreichbar ist (Standard-TCP-Port **5000**).

### Adapter installieren

Der Adapter ist (noch) nicht im ioBroker-Repository. Installation per GitHub-URL / Entwicklermodus:

```bash
# im ioBroker-Adapterverzeichnis, z. B. /opt/iobroker
iobroker url "https://github.com/InboundSolution/ioBroker.dahua-vto"
```

Alternativ über die ioBroker-CLI aus einem lokalen Checkout:

```bash
npm install <pfad-zu-diesem-repo>
iobroker upload dahua-vto
```

Danach eine Instanz anlegen und in den **Instanz-Einstellungen** IP, Port, Benutzer und Passwort hinterlegen.

## Konfiguration

| Feld | Standard | Beschreibung |
| ---- | -------- | ------------ |
| IP-Adresse / Hostname | – | Adresse der VTO/VTH (Pflichtfeld) |
| Port | 5000 | TCP-Port des DHIP-Dienstes |
| Benutzername | admin | Lokaler Gerätebenutzer |
| Passwort | – | Passwort des Gerätebenutzers |
| Türkanal | 1 | Kanal des Türöffners (1-basiert) |
| Door-Index | 0 | `DoorIndex`-Parameter des Türöffners |
| Short-Number | 1 | `ShortNumber`-Parameter des Türöffners |
| Ereignis-Codes für Klingel-Trigger | `BackKeyLight, AlarmLocal` | Kommagetrennte Liste der Ereignis-Codes, die `doorbell.trigger` auslösen |
| Datenpunkt je Ereignis-Code | ✔ | Legt `events.<Code>` für jedes empfangene Ereignis an |
| Wiederverbindungs-Intervall | 30 s | Wartezeit zwischen Verbindungsversuchen |
| Antwort-Timeout | 10 s | Max. Wartezeit auf Geräteantworten |

## Datenpunkte

| Datenpunkt | Rolle | Beschreibung |
| ---------- | ----- | ------------ |
| `info.connection` | – | Verbindungsanzeige (true = angemeldet) |
| `device.deviceType` | info.name | Gerätetyp laut `magicBox.getSystemInfo` |
| `device.serialNumber` | info.serial | Seriennummer |
| `device.systemInfo` | json | Komplette Systeminformationen als JSON |
| `door.open` | button | **Schreibbar**: auf `true` setzen, um den Türöffner auszulösen |
| `door.status` | sensor.door | Türstatus aus `DoorStatus`-Ereignissen (true = offen) |
| `doorbell.trigger` | button | Für ca. 1 s `true`, wenn ein Klingel-Ereignis eintrifft |
| `doorbell.code` | text | Ereignis-Code der letzten Klingel |
| `events.lastEvent.code` | text | Code des letzten Ereignisses |
| `events.lastEvent.data` | json | Daten des letzten Ereignisses (JSON) |
| `events.lastEvent.time` | date | Zeitpunkt (ISO) des letzten Ereignisses |
| `events.<Code>` | json | Daten (JSON) je Ereignis-Code, z. B. `events.BackKeyLight`, `events.AccessControl` |

### Beispiele

**Klingel-Push bei Ereignis:**

```javascript
// Blockly / JavaScript-Trigger
on({ id: 'dahua-vto.0.doorbell.trigger', val: true }, (obj) => {
    // z. B. Push-Nachricht, Licht einschalten, Beschattung hochfahren …
    sendTo('telegram.0', 'send', { text: 'Es hat geklingelt!' });
});
```

**Türöffner (auch aus der Visualisierung):**

```javascript
setState('dahua-vto.0.door.open', true);
```

**Auf Anruf-Status reagieren (VTH/VTO):**

```javascript
on({ id: 'dahua-vto.0.events.CallDlgStatus', change: 'ne' }, (obj) => {
    const data = JSON.parse(obj.state.val);
    console.log('Anruf-Status:', data);
});
```

## Typische Ereignis-Codes

| Code | Bedeutung |
| ---- | --------- |
| `BackKeyLight` | Tastenbeleuchtung/Klingelanzeige an der Innenstation (VTH) – typischer Klingel-Trigger |
| `AlarmLocal` | Lokaler Alarm an der Außenstation, z. B. gedrückte Klingeltaste (VTO) |
| `CallDlgStatus` | Status des Anruf-Dialogs (Klingeln, Verbindung, Ende) |
| `CrossTalkStat` | Interner Gesprächsstatus zwischen Stationen |
| `DoorStatus` | Türstatus (offen/geschlossen) |
| `AccessControl` | Zugang per Karte/Code/Fingerabdruck |
| `VideoTalkLog` | Gesprächsprotokoll der Türkommunikation |
| `CallSnapInfo` | Snapshot-Informationen eines Anrufs |

> 💡 Am einfachsten findet man die relevanten Codes für das eigene Gerät, indem man `events.lastEvent.code` beobachtet oder den Adapter in den Debug-Modus stellt – jedes Ereignis wird mit Code und Daten geloggt. Die gefundenen Codes trägt man dann als Klingel-Trigger ein.

## Entwicklung

```bash
npm install      # Abhängigkeiten installieren
npm run lint     # ESLint
npm test         # Lint + Unit-/Paket-Tests
```

Adapter-Entwicklung nach den [ioBroker-Entwicklerrichtlinien](https://github.com/ioBroker/ioBroker.docs/blob/master/docs/en/dev/adapterdev.md). Debug-Log aktivieren: Instanz → Expertenmodus → Log-Stufe `debug`.

### Architektur

```
main.js               Adapter-Klasse (Datenpunkte, Trigger, Konfiguration)
lib/dahuaClient.js    DHIP-Protokoll: TCP-Framing, MD5-Login, Requests, Event-Stream, openDoor
admin/jsonConfig.json Admin-Konfiguration (JSON-Config, Admin 5+)
```

Das Protokoll ist eine eigenständige JavaScript-Implementierung des DHIP-Verfahrens (32-Byte-Header, `global.login` mit `MD5(user:realm:pass)` / `MD5(user:random:hash)`, `eventManager.attach`, `accessControl.factory.instance` + `openDoor`), orientiert am Verhalten des Vorbildprojekts.

## Credits / Lizenz

- Protokoll-Vorbild: [myhomeiot/DahuaVTO](https://github.com/myhomeiot/DahuaVTO) (GPL-3.0)
- Dieser Adapter: **MIT** – siehe [LICENSE](LICENSE).

## Disclaimer

Dies ist keine offizielle Software von Dahua Technology. Alle Marken gehören ihren jeweiligen Eigentümern. Die Nutzung erfolgt auf eigene Verantwortung; für Schäden an Hardware oder Firmware wird keine Haftung übernommen.
