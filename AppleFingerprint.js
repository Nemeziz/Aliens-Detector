// AppleFingerprint.js
// Identifica iPhones por su Continuity Protocol advertising data
// aunque la MAC sea aleatoria y cambie

const APPLE_COMPANY_ID = 0x004C;

// Tipos de mensaje Apple Continuity Protocol
const APPLE_MSG_TYPES = {
  0x02: { name: 'iBeacon',        icon: '📍' },
  0x05: { name: 'AirDrop',        icon: '📤' },
  0x07: { name: 'AirPods',        icon: '🎧' },
  0x08: { name: 'Hey Siri',       icon: '🎙️' },
  0x09: { name: 'AirPlay Target', icon: '📺' },
  0x0A: { name: 'AirPlay Source', icon: '📱' },
  0x0B: { name: 'MagicSwitch',    icon: '⌨️' },
  0x0C: { name: 'Handoff',        icon: '🤝' },
  0x0D: { name: 'Wi-Fi Settings', icon: '📶' },
  0x0E: { name: 'Hotspot',        icon: '🔥' },
  0x0F: { name: 'Tethering',      icon: '🔗' },
  0x10: { name: 'Nearby',         icon: '📱' }, // iPhone activo más común
  0x11: { name: 'Watch',          icon: '⌚' },
  0x12: { name: 'Wi-Fi Pass',     icon: '🔑' },
  0x13: { name: 'Hotspot Target', icon: '🔥' },
};

/**
 * Parsea el manufacturer data de un dispositivo Apple
 * @param {object|string} mfData - manufacturerData de ble-manager
 * @returns {object|null} fingerprint del dispositivo
 */
export function parseAppleAdvertising(mfData) {
  if (!mfData) return null;

  let bytes = null;
  if (mfData.bytes && Array.isArray(mfData.bytes)) {
    bytes = mfData.bytes;
  } else if (typeof mfData === 'string') {
    // hex string
    bytes = [];
    for (let i = 0; i < mfData.length; i += 2) {
      bytes.push(parseInt(mfData.substring(i, i+2), 16));
    }
  } else if (mfData.data) {
    // base64
    try {
      const bin = atob(mfData.data);
      bytes = Array.from(bin).map(c => c.charCodeAt(0));
    } catch { return null; }
  }

  if (!bytes || bytes.length < 2) return null;

  // Company ID en little-endian
  const companyId = bytes[0] | (bytes[1] << 8);
  if (companyId !== APPLE_COMPANY_ID) return null;

  // Parsear mensajes Apple (puede haber múltiples concatenados)
  const messages = [];
  let i = 2;
  while (i < bytes.length - 1) {
    const msgType = bytes[i];
    const msgLen = bytes[i+1];
    if (msgLen === 0 || i + 2 + msgLen > bytes.length) break;
    const payload = bytes.slice(i+2, i+2+msgLen);
    const typeInfo = APPLE_MSG_TYPES[msgType];
    messages.push({
      type: msgType,
      typeName: typeInfo?.name || `Type_0x${msgType.toString(16).toUpperCase()}`,
      icon: typeInfo?.icon || '📡',
      length: msgLen,
      payload,
      // status byte (primer byte del payload) — indica estado del dispositivo
      statusByte: payload.length > 0 ? payload[0] : null,
    });
    i += 2 + msgLen;
  }

  if (messages.length === 0) return null;

  // El fingerprint estable es: tipo(s) de mensaje + longitud(es)
  // Esto NO cambia aunque rote la MAC
  const fingerprint = messages.map(m => `${m.type}:${m.length}`).join('|');
  const primaryMsg = messages[0];

  return {
    vendor: 'Apple',
    companyId,
    messages,
    primaryType: primaryMsg.type,
    primaryName: primaryMsg.typeName,
    primaryIcon: primaryMsg.icon,
    fingerprint, // ← clave de identificación estable
    allTypes: messages.map(m => m.typeName).join(', '),
  };
}

/**
 * Genera un nombre descriptivo para un dispositivo Apple identificado
 */
export function appleDisplayName(parsed, mac) {
  if (!parsed) return null;
  const short = mac ? mac.slice(-5) : '??';
  return `${parsed.primaryIcon} ${parsed.primaryName} [${short}]`;
}

/**
 * Compara si dos fingerprints Apple son del mismo dispositivo
 * (aunque tengan MACs diferentes)
 */
export function isSameAppleDevice(fp1, fp2) {
  if (!fp1 || !fp2) return false;
  return fp1 === fp2;
}
