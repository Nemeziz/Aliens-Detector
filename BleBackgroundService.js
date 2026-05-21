// BleBackgroundService.js
// Foreground Service para BLE scan en background con notificación persistente

import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import { BleManager } from 'react-native-ble-plx';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const BLE_BACKGROUND_TASK = 'BLE_BACKGROUND_SCAN';
const CONTACTS_KEY = 'aliens_contacts';
const RSSI_THRESHOLD = -75; // dBm — más fuerte que esto = "cerca"
const NOTIF_CHANNEL = 'ble-tracker';
const SCAN_DURATION = 4000; // ms por ciclo de scan
const COOLDOWN_KEY = 'aliens_alert_cooldown'; // evitar spam de notifs

// ── configurar canal de notificaciones ────────────────────────────────────────
export async function setupNotifications() {
  await Notifications.setNotificationChannelAsync(NOTIF_CHANNEL, {
    name: 'BLE Tracker',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 150, 250],
    sound: null,
    enableVibrate: true,
  });

  await Notifications.setNotificationChannelAsync('ble-foreground', {
    name: 'Rastreo Activo',
    importance: Notifications.AndroidImportance.LOW, // silenciosa, persistente
    enableVibrate: false,
    sound: null,
  });

  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

// ── notificación persistente (foreground service indicator) ───────────────────
let foregroundNotifId = null;

export async function showForegroundNotification(contactNames = []) {
  const names = contactNames.length > 0
    ? contactNames.join(', ')
    : 'contactos con alerta';

  const id = await Notifications.scheduleNotificationAsync({
    content: {
      title: '👾 MOTION TRACKER ACTIVO',
      body: `Buscando: ${names}`,
      sticky: true,
      autoDismiss: false,
      data: { type: 'foreground' },
      android: {
        channelId: 'ble-foreground',
        ongoing: true,
        color: '#00ff41',
        smallIcon: 'notification_icon',
        priority: 'low',
      },
    },
    trigger: null, // inmediata
  });
  foregroundNotifId = id;
  return id;
}

export async function dismissForegroundNotification() {
  if (foregroundNotifId) {
    await Notifications.dismissNotificationAsync(foregroundNotifId);
    foregroundNotifId = null;
  }
  await Notifications.dismissAllNotificationsAsync();
}

// ── notificación de alerta de proximidad ──────────────────────────────────────
async function sendProximityAlert(contactAlias, distance, rssi) {
  // cooldown: no spamear más de 1 notif por contacto cada 30 segundos
  const cooldownRaw = await AsyncStorage.getItem(COOLDOWN_KEY);
  const cooldown = cooldownRaw ? JSON.parse(cooldownRaw) : {};
  const now = Date.now();
  if (cooldown[contactAlias] && now - cooldown[contactAlias] < 30000) return;

  cooldown[contactAlias] = now;
  await AsyncStorage.setItem(COOLDOWN_KEY, JSON.stringify(cooldown));

  await Notifications.scheduleNotificationAsync({
    content: {
      title: `⚠️ ${contactAlias} DETECTADO`,
      body: `Distancia aprox: ${distance}  ·  ${rssi} dBm`,
      data: { type: 'proximity', alias: contactAlias },
      android: {
        channelId: NOTIF_CHANNEL,
        color: '#00ff41',
        vibrate: [0, 300, 100, 300],
        priority: 'high',
      },
    },
    trigger: null,
  });
}

// ── tarea de background ───────────────────────────────────────────────────────
TaskManager.defineTask(BLE_BACKGROUND_TASK, async () => {
  let bleManager = null;
  try {
    // cargar contactos con alerta activa
    const raw = await AsyncStorage.getItem(CONTACTS_KEY);
    if (!raw) return TaskManager.TaskState.NoData;
    const contacts = JSON.parse(raw);
    const alertContacts = Object.values(contacts).filter(c => c.alertEnabled);
    if (alertContacts.length === 0) return TaskManager.TaskState.NoData;

    const alertIds = new Set(alertContacts.map(c => c.id));
    const found = {};

    bleManager = new BleManager();

    // escanear por SCAN_DURATION ms
    await new Promise((resolve) => {
      bleManager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
        if (error || !device) return;
        if (alertIds.has(device.id) && device.rssi && device.rssi > RSSI_THRESHOLD) {
          found[device.id] = { rssi: device.rssi, device };
        }
      });
      setTimeout(resolve, SCAN_DURATION);
    });

    bleManager.stopDeviceScan();

    // enviar alertas para los encontrados
    for (const [id, { rssi }] of Object.entries(found)) {
      const contact = contacts[id];
      if (!contact) continue;
      const d = Math.pow(10, (-59 - rssi) / 20);
      const distStr = d < 1 ? `${Math.round(d * 100)}cm` : d > 50 ? '>50m' : `${d.toFixed(1)}m`;
      await sendProximityAlert(contact.alias, distStr, rssi);
    }

    return TaskManager.TaskState.NewData;
  } catch (e) {
    return TaskManager.TaskState.Failed;
  } finally {
    try { bleManager?.destroy(); } catch {}
  }
});
