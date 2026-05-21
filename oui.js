// OUI database — primeros 3 bytes del MAC → fabricante y tipo
// Fuente: IEEE OUI registry (subconjunto de los más comunes en BLE)
const OUI_DB = {
  // Apple
  'A4:C3:F0': { vendor: 'Apple',   type: 'iPhone',  icon: '󰀷' },
  'F0:DB:E2': { vendor: 'Apple',   type: 'iPhone',  icon: '󰀷' },
  'DC:2C:26': { vendor: 'Apple',   type: 'iPhone',  icon: '󰀷' },
  'F4:F1:5A': { vendor: 'Apple',   type: 'iPhone',  icon: '󰀷' },
  'BC:D0:74': { vendor: 'Apple',   type: 'MacBook', icon: '󰀵' },
  'A8:51:AB': { vendor: 'Apple',   type: 'AirPods', icon: '󰋋' },
  '28:6B:B4': { vendor: 'Apple',   type: 'iPhone',  icon: '󰀷' },
  '68:DF:A5': { vendor: 'Apple',   type: 'iPhone',  icon: '󰀷' },
  '61:AC:E9': { vendor: 'Apple',   type: 'Apple',   icon: '󰀷' },
  'F8:4D:89': { vendor: 'Apple',   type: 'Apple',   icon: '󰀷' },
  'B8:8D:12': { vendor: 'Apple',   type: 'Apple',   icon: '󰀷' },
  // Samsung
  'F4:7B:5E': { vendor: 'Samsung', type: 'Phone',   icon: '󰄜' },
  '8C:F5:A3': { vendor: 'Samsung', type: 'Phone',   icon: '󰄜' },
  'DC:71:96': { vendor: 'Samsung', type: 'Phone',   icon: '󰄜' },
  'A0:82:1F': { vendor: 'Samsung', type: 'Watch',   icon: '󰧞' },
  '78:BD:BC': { vendor: 'Samsung', type: 'Buds',    icon: '󰋋' },
  'CC:4B:73': { vendor: 'Samsung', type: 'Phone',   icon: '󰄜' },
  'E4:A8:DF': { vendor: 'Samsung', type: 'Phone',   icon: '󰄜' },
  // Xiaomi
  'AC:C1:EE': { vendor: 'Xiaomi',  type: 'Phone',   icon: '󰄜' },
  '64:B4:73': { vendor: 'Xiaomi',  type: 'Phone',   icon: '󰄜' },
  '28:6C:07': { vendor: 'Xiaomi',  type: 'Phone',   icon: '󰄜' },
  'F8:A2:D6': { vendor: 'Xiaomi',  type: 'Band',    icon: '󰧞' },
  // Google
  'F4:85:89': { vendor: 'Google',  type: 'Pixel',   icon: '󰄜' },
  'A4:77:33': { vendor: 'Google',  type: 'Pixel',   icon: '󰄜' },
  '3C:28:6D': { vendor: 'Google',  type: 'Pixel',   icon: '󰄜' },
  // Huawei
  'AC:E0:10': { vendor: 'Huawei',  type: 'Phone',   icon: '󰄜' },
  '54:92:BE': { vendor: 'Huawei',  type: 'Watch',   icon: '󰧞' },
  // OnePlus
  '94:65:2D': { vendor: 'OnePlus', type: 'Phone',   icon: '󰄜' },
  // Sony
  '00:17:EF': { vendor: 'Sony',    type: 'Audio',   icon: '󰋋' },
  'A8:9C:ED': { vendor: 'Sony',    type: 'Phone',   icon: '󰄜' },
  // Amazfit / Zepp
  'AC:87:A3': { vendor: 'Amazfit', type: 'Watch',   icon: '󰧞' },
  // Fitbit
  'C4:BE:84': { vendor: 'Fitbit',  type: 'Band',    icon: '󰧞' },
  // Garmin
  '00:1D:0A': { vendor: 'Garmin',  type: 'Watch',   icon: '󰧞' },
  // Laptops / PCs genéricos
  '00:15:5D': { vendor: 'Microsoft', type: 'PC',    icon: '󰍹' },
  // Bocinas / Audio genérico
  '00:0F:DE': { vendor: 'Audio',   type: 'Speaker', icon: '󰓃' },
};

// Prefijos de MAC aleatorios (bit 1 del primer byte = 1 → privado/aleatorio)
function isRandomMac(mac) {
  if (!mac || mac.length < 2) return false;
  const firstByte = parseInt(mac.split(':')[0], 16);
  return !!(firstByte & 0x02); // bit LAA
}

export function resolveDevice(id, advertisedName) {
  // Normalizar ID a formato MAC si es posible
  const mac = id.replace(/-/g, ':').toUpperCase();
  const oui = mac.substring(0, 8); // XX:XX:XX

  // Buscar en OUI DB
  const match = OUI_DB[oui];

  // Últimos 4 chars del ID (más legible que DEV-XXXX)
  const tail = mac.slice(-5).replace(':', ''); // ej: "A40A"

  // Nombre a mostrar
  let displayName = advertisedName;
  if (!displayName || displayName.startsWith('DEV-') || displayName.startsWith('[')) {
    if (match) {
      displayName = `${match.vendor} ${match.type}`;
    } else if (isRandomMac(mac)) {
      displayName = `BLE·${tail}`;
    } else {
      displayName = `DEV·${tail}`;
    }
  }

  // Tipo de dispositivo
  let deviceType = 'Unknown';
  let vendor = '';
  if (match) {
    deviceType = match.type;
    vendor = match.vendor;
  } else if (isRandomMac(mac)) {
    deviceType = 'Random';
    vendor = 'Private';
  }

  return { displayName, deviceType, vendor, tail, isRandom: isRandomMac(mac) };
}

export function getDeviceTypeLabel(deviceType) {
  const labels = {
    'iPhone': '📱', 'Phone': '📱', 'Pixel': '📱',
    'MacBook': '💻', 'PC': '💻',
    'Watch': '⌚', 'Band': '⌚',
    'AirPods': '🎧', 'Buds': '🎧', 'Audio': '🎧', 'Speaker': '🔊',
    'Random': '🔀', 'Unknown': '·',
  };
  return labels[deviceType] || '·';
}
