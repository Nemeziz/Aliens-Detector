import React from 'react';
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet,
  Platform, Modal, SafeAreaView,
} from 'react-native';

const MONO = Platform.OS === 'ios' ? 'Courier' : 'monospace';
const GREEN = '#00ff41';
const DIMGREEN = '#00551a';
const BG = '#000d00';

const RSSI_MIN = -100;
const RSSI_MAX = -45;

function rssiToPercent(rssi) {
  const c = Math.max(RSSI_MIN, Math.min(RSSI_MAX, rssi));
  return (c - RSSI_MIN) / (RSSI_MAX - RSSI_MIN);
}
function rssiToDistance(rssi) {
  const d = Math.pow(10, (-59 - rssi) / 20);
  if (d < 1) return `${Math.round(d * 100)} cm`;
  if (d > 50) return '>50 m';
  return `${d.toFixed(1)} m`;
}
function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

function rssiColor(rssi) {
  if (rssi >= -55) return '#00ff41';
  if (rssi >= -65) return '#88ff00';
  if (rssi >= -75) return '#ffcc00';
  if (rssi >= -85) return '#ff8800';
  return '#ff4444';
}

function DeviceRow({ dev, contact, onStar, onTrack, onLongPress }) {
  const avgRssi = Math.round(avg(dev.rssiHistory));
  const pct = rssiToPercent(avgRssi);
  const color = rssiColor(avgRssi);
  const dist = rssiToDistance(avgRssi);
  const isContact = !!contact;
  const timeSince = Math.round((Date.now() - dev.lastSeen) / 1000);
  const isStale = timeSince > 15;

  return (
    <TouchableOpacity
      style={[styles.row, isContact && styles.rowContact]}
      onPress={() => onTrack(dev.id)}
      onLongPress={() => onLongPress(dev)}
      activeOpacity={0.7}
    >
      {/* círculo RSSI */}
      <View style={[styles.rssiCircle, { borderColor: color, opacity: isStale ? 0.4 : 1 }]}>
        <Text style={[styles.rssiVal, { color }]}>{avgRssi}</Text>
        <Text style={styles.rssiUnit}>dBm</Text>
      </View>

      {/* info central */}
      <View style={styles.rowInfo}>
        {/* nombre o alias */}
        <View style={styles.nameRow}>
          {isContact && (
            <View style={styles.aliasBadge}>
              <Text style={styles.aliasBadgeText}>{contact.alias}</Text>
            </View>
          )}
          <Text style={[styles.devName, isContact && { color: '#00ccff' }]} numberOfLines={1}>
            {dev.rawName || (isContact ? contact.name : null) || '—'}
          </Text>
        </View>
        {/* MAC */}
        <Text style={styles.devMac} numberOfLines={1}>{dev.id.length >= 17 ? dev.id.slice(-17) : dev.id}</Text>
        {/* distancia y tiempo */}
        <View style={styles.rowMeta}>
          <Text style={[styles.metaText, { color }]}>Dist: {dist}</Text>
          {isStale && <Text style={[styles.metaText, { color: '#555' }]}>  · {timeSince}s ago</Text>}
          {isContact && contact.alertEnabled && <Text style={styles.metaBell}>  🔔</Text>}
        </View>
      </View>

      {/* estrella */}
      <TouchableOpacity style={styles.starBtn} onPress={() => onStar(dev)}>
        <Text style={[styles.starIcon, isContact && { color: '#ffdd00' }]}>
          {isContact ? '★' : '☆'}
        </Text>
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

export default function ScanScreen({ visible, devices, contacts, onClose, onTrack, onStar, onLongPress, scanning }) {
  const count = devices.length;

  return (
    <Modal visible={visible} animationType="slide" transparent={false}>
      <SafeAreaView style={styles.root}>
        {/* cabecera */}
        <View style={styles.header}>
          <View>
            <Text style={styles.headerTitle}>SEÑALES BLE</Text>
            <Text style={styles.headerSub}>
              {count} dispositivos{scanning ? ' · escaneando...' : ' · detenido'}
            </Text>
          </View>
          <TouchableOpacity style={styles.btnClose} onPress={onClose}>
            <Text style={styles.btnCloseText}>[ RADAR ]</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.headerLine} />

        {/* leyenda */}
        <View style={styles.legend}>
          <Text style={styles.legendItem}>☆ = guardar contacto</Text>
          <Text style={styles.legendItem}>★ = contacto guardado</Text>
          <Text style={styles.legendItem}>Toca = rastrear</Text>
        </View>

        {/* lista */}
        {count === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              {scanning ? 'Buscando dispositivos...' : 'Sin señales detectadas'}
            </Text>
          </View>
        ) : (
          <FlatList
            data={devices}
            keyExtractor={d => d.id}
            renderItem={({ item }) => (
              <DeviceRow
                dev={item}
                contact={contacts[item.id]}
                onStar={onStar}
                onTrack={(id) => { onTrack(id); onClose(); }}
                onLongPress={onLongPress}
              />
            )}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            contentContainerStyle={{ paddingBottom: 20 }}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10,
  },
  headerTitle: { color: GREEN, fontSize: 18, fontWeight: 'bold', letterSpacing: 4, fontFamily: MONO },
  headerSub: { color: DIMGREEN, fontSize: 10, letterSpacing: 1, fontFamily: MONO, marginTop: 2 },
  btnClose: { borderWidth: 1, borderColor: GREEN, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 8 },
  btnCloseText: { color: GREEN, fontSize: 12, fontFamily: MONO, letterSpacing: 2 },
  headerLine: { height: 1, backgroundColor: DIMGREEN, marginHorizontal: 16, marginBottom: 6 },
  legend: {
    flexDirection: 'row', justifyContent: 'space-around',
    paddingVertical: 6, paddingHorizontal: 8,
    backgroundColor: '#000a00', marginBottom: 4,
  },
  legendItem: { color: '#004415', fontSize: 9, fontFamily: MONO },

  // filas
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: '#00060000',
  },
  rowContact: { backgroundColor: '#00100800' },
  separator: { height: 1, backgroundColor: '#001a00', marginHorizontal: 12 },

  // círculo RSSI
  rssiCircle: {
    width: 58, height: 58, borderRadius: 29,
    borderWidth: 2, alignItems: 'center', justifyContent: 'center',
    marginRight: 12, backgroundColor: '#000d00',
  },
  rssiVal: { fontSize: 17, fontWeight: 'bold', fontFamily: MONO },
  rssiUnit: { color: '#005520', fontSize: 8, fontFamily: MONO },

  // info
  rowInfo: { flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 },
  aliasBadge: {
    backgroundColor: '#003344', borderRadius: 4,
    paddingHorizontal: 6, paddingVertical: 1,
  },
  aliasBadgeText: { color: '#00ccff', fontSize: 11, fontFamily: MONO, fontWeight: 'bold' },
  devName: { color: '#aaffaa', fontSize: 13, fontFamily: MONO, flex: 1 },
  devMac: { color: GREEN, fontSize: 12, fontFamily: MONO, letterSpacing: 1, marginBottom: 3 },
  rowMeta: { flexDirection: 'row', alignItems: 'center' },
  metaText: { fontSize: 10, fontFamily: MONO },
  metaBell: { fontSize: 10 },

  // estrella
  starBtn: { padding: 8, marginLeft: 4 },
  starIcon: { fontSize: 26, color: '#003310' },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: DIMGREEN, fontSize: 13, fontFamily: MONO, letterSpacing: 2 },
});
