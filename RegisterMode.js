import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal,
  Animated, Platform, NativeEventEmitter, NativeModules,
} from 'react-native';
import BleManager from 'react-native-ble-manager';

const MONO = Platform.OS === 'ios' ? 'Courier' : 'monospace';
const GREEN = '#00ff41';
const SCAN_SECONDS = 10;
const BleManagerEmitter = new NativeEventEmitter(NativeModules.BleManager);

export default function RegisterMode({ visible, onDeviceFound, onClose }) {
  const [phase, setPhase] = useState('idle');
  const [secondsLeft, setSecondsLeft] = useState(SCAN_SECONDS);
  const [candidates, setCandidates] = useState({});
  const [bestDevice, setBestDevice] = useState(null);
  const timerRef = useRef(null);
  const scanRef = useRef(false);
  const seenRef = useRef({});
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseLoop = useRef(null);
  const listenerRef = useRef(null);

  useEffect(() => {
    if (!visible) reset();
  }, [visible]);

  function reset() {
    scanRef.current = false;
    BleManager.stopScan();
    listenerRef.current?.remove();
    if (timerRef.current) clearInterval(timerRef.current);
    pulseLoop.current?.stop();
    seenRef.current = {};
    setPhase('idle');
    setSecondsLeft(SCAN_SECONDS);
    setCandidates({});
    setBestDevice(null);
  }

  function startPulse() {
    pulseAnim.setValue(1);
    pulseLoop.current = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.3, duration: 500, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
      ])
    );
    pulseLoop.current.start();
  }

  async function startScan() {
    setPhase('scanning');
    setSecondsLeft(SCAN_SECONDS);
    setCandidates({});
    setBestDevice(null);
    seenRef.current = {};
    scanRef.current = true;
    startPulse();

    // listener de descubrimiento
    listenerRef.current = BleManagerEmitter.addListener(
      'BleManagerDiscoverPeripheral',
      (peripheral) => {
        if (!scanRef.current) return;
        const id = peripheral.id;
        const rssi = peripheral.rssi ?? -100;
        const name = peripheral.name || peripheral.advertising?.localName || null;

        if (!seenRef.current[id]) {
          seenRef.current[id] = { id, rssi, name, samples: [rssi] };
        } else {
          seenRef.current[id].samples.push(rssi);
          const s = seenRef.current[id].samples.slice(-5);
          seenRef.current[id].rssi = Math.round(s.reduce((a, b) => a + b, 0) / s.length);
          if (name && !seenRef.current[id].name) seenRef.current[id].name = name;
        }
        setCandidates({ ...seenRef.current });
      }
    );

    await BleManager.scan([], SCAN_SECONDS, true, { scanMode: 2, reportDelay: 0 });

    // countdown
    timerRef.current = setInterval(() => {
      setSecondsLeft(prev => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          finishScan();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  function finishScan() {
    scanRef.current = false;
    listenerRef.current?.remove();
    BleManager.stopScan();
    pulseLoop.current?.stop();

    const list = Object.values(seenRef.current);
    if (list.length === 0) { setPhase('failed'); return; }
    const best = list.reduce((a, b) => a.rssi > b.rssi ? a : b);
    setBestDevice(best);
    setPhase('found');
  }

  function handleConfirm() {
    if (bestDevice) { onDeviceFound(bestDevice); reset(); }
  }

  function handleRetry() { reset(); setTimeout(startScan, 300); }

  const topCandidates = Object.values(candidates).sort((a, b) => b.rssi - a.rssi).slice(0, 6);
  const progressPct = ((SCAN_SECONDS - secondsLeft) / SCAN_SECONDS) * 100;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.box}>
          <Text style={styles.title}>[ MODO REGISTRO ]</Text>
          <Text style={styles.subtitle}>Pon el teléfono del familiar{'\n'}MUY CERCA del tuyo</Text>

          {phase === 'idle' && (
            <>
              <View style={styles.instructionBox}>
                <Text style={styles.step}>① Activa Bluetooth en su teléfono</Text>
                <Text style={styles.step}>② Ponlo a menos de 30 cm del tuyo</Text>
                <Text style={styles.step}>③ Presiona INICIAR ESCANEO</Text>
                <Text style={styles.step}>④ Confirma el dispositivo más cercano</Text>
              </View>
              <TouchableOpacity style={styles.btnStart} onPress={startScan}>
                <Text style={styles.btnStartText}>▶ INICIAR ESCANEO</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btnClose} onPress={onClose}>
                <Text style={styles.btnCloseText}>[ CANCELAR ]</Text>
              </TouchableOpacity>
            </>
          )}

          {phase === 'scanning' && (
            <>
              <View style={styles.countdownBox}>
                <Animated.Text style={[styles.countdown, { transform: [{ scale: pulseAnim }] }]}>
                  {secondsLeft}
                </Animated.Text>
                <Text style={styles.countdownLabel}>ESCANEANDO...</Text>
              </View>
              <View style={styles.progressBg}>
                <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
              </View>
              {topCandidates.length > 0 && (
                <View style={styles.candidatesBox}>
                  <Text style={styles.candidatesTitle}>DISPOSITIVOS DETECTADOS</Text>
                  {topCandidates.map((dev, i) => (
                    <View key={dev.id} style={[styles.candidateRow, i===0 && styles.candidateRowBest]}>
                      <Text style={[styles.candidateRank, i===0 && {color:GREEN}]}>{i===0?'▶':`${i+1}`}</Text>
                      <View style={{flex:1}}>
                        <Text style={[styles.candidateName, i===0 && {color:GREEN}]} numberOfLines={1}>
                          {dev.name || dev.id.slice(-17)}
                        </Text>
                      </View>
                      <Text style={[styles.candidateRssi, {
                        color: dev.rssi>-60 ? GREEN : dev.rssi>-75 ? '#ffaa00' : '#ff4444'
                      }]}>{dev.rssi} dBm</Text>
                    </View>
                  ))}
                </View>
              )}
              <TouchableOpacity style={styles.btnClose} onPress={reset}>
                <Text style={styles.btnCloseText}>[ CANCELAR ]</Text>
              </TouchableOpacity>
            </>
          )}

          {phase === 'found' && bestDevice && (
            <>
              <View style={styles.foundBox}>
                <Text style={styles.foundIcon}>📱</Text>
                <Text style={styles.foundLabel}>DISPOSITIVO MÁS CERCANO</Text>
                <Text style={styles.foundName}>{bestDevice.name || bestDevice.id.slice(-17)}</Text>
                <Text style={styles.foundId}>{bestDevice.id.slice(-17)}</Text>
                <Text style={[styles.foundRssi, {
                  color: bestDevice.rssi>-60 ? GREEN : bestDevice.rssi>-75 ? '#ffaa00' : '#ff4444'
                }]}>
                  {bestDevice.rssi} dBm  ·  ~{Math.pow(10,(-59-bestDevice.rssi)/20).toFixed(1)}m
                </Text>
              </View>
              <Text style={styles.confirmQuestion}>¿Es el dispositivo correcto?</Text>
              <View style={styles.foundButtons}>
                <TouchableOpacity style={styles.btnRetry} onPress={handleRetry}>
                  <Text style={styles.btnRetryText}>[ REINTENTAR ]</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.btnConfirm} onPress={handleConfirm}>
                  <Text style={styles.btnConfirmText}>[ SÍ, GUARDAR ]</Text>
                </TouchableOpacity>
              </View>
              {topCandidates.length > 1 && (
                <View style={[styles.candidatesBox, {marginTop:10}]}>
                  <Text style={styles.candidatesTitle}>¿NO ES ESE? OTROS DETECTADOS</Text>
                  {topCandidates.slice(1).map(dev => (
                    <TouchableOpacity key={dev.id} style={styles.candidateRow} onPress={() => setBestDevice(dev)}>
                      <View style={{flex:1}}>
                        <Text style={styles.candidateName} numberOfLines={1}>{dev.name || dev.id.slice(-17)}</Text>
                      </View>
                      <Text style={[styles.candidateRssi, {color:'#ffaa00'}]}>{dev.rssi} dBm</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </>
          )}

          {phase === 'failed' && (
            <>
              <Text style={styles.failedText}>No se detectaron dispositivos.{'\n\n'}Asegúrate que Bluetooth esté activo y que el teléfono esté cerca.</Text>
              <TouchableOpacity style={styles.btnStart} onPress={handleRetry}>
                <Text style={styles.btnStartText}>⟳ REINTENTAR</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btnClose} onPress={onClose}>
                <Text style={styles.btnCloseText}>[ CANCELAR ]</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay:{flex:1,backgroundColor:'#000d00ee',justifyContent:'center',padding:16},
  box:{backgroundColor:'#000f00',borderWidth:1,borderColor:GREEN,borderRadius:8,padding:18},
  title:{color:GREEN,fontSize:14,letterSpacing:3,fontFamily:MONO,textAlign:'center',marginBottom:6},
  subtitle:{color:'#005520',fontSize:11,fontFamily:MONO,textAlign:'center',marginBottom:14,lineHeight:18},
  instructionBox:{borderWidth:1,borderColor:'#002a00',borderRadius:6,padding:12,marginBottom:16,gap:8},
  step:{color:'#00aa33',fontSize:12,fontFamily:MONO,lineHeight:20},
  countdownBox:{alignItems:'center',marginBottom:12},
  countdown:{color:GREEN,fontSize:52,fontWeight:'bold',fontFamily:MONO},
  countdownLabel:{color:'#005520',fontSize:10,letterSpacing:4,fontFamily:MONO},
  progressBg:{height:4,backgroundColor:'#001a00',borderRadius:2,overflow:'hidden',marginBottom:12},
  progressFill:{height:'100%',backgroundColor:GREEN,borderRadius:2},
  candidatesBox:{borderWidth:1,borderColor:'#002a00',borderRadius:6,padding:8,marginBottom:10},
  candidatesTitle:{color:'#005520',fontSize:8,letterSpacing:2,fontFamily:MONO,marginBottom:6},
  candidateRow:{flexDirection:'row',alignItems:'center',paddingVertical:5,borderBottomWidth:1,borderColor:'#001500',gap:6},
  candidateRowBest:{backgroundColor:'#001a00',borderRadius:4,paddingHorizontal:4},
  candidateRank:{color:'#005520',fontSize:10,fontFamily:MONO,width:14},
  candidateName:{color:'#009933',fontSize:11,fontFamily:MONO},
  candidateRssi:{fontSize:11,fontFamily:MONO,fontWeight:'bold'},
  foundBox:{alignItems:'center',borderWidth:1,borderColor:GREEN,borderRadius:8,padding:16,marginBottom:12,backgroundColor:'#001a00'},
  foundIcon:{fontSize:32,marginBottom:6},
  foundLabel:{color:'#005520',fontSize:8,letterSpacing:3,fontFamily:MONO,marginBottom:6},
  foundName:{color:GREEN,fontSize:16,fontWeight:'bold',fontFamily:MONO,textAlign:'center'},
  foundId:{color:'#005520',fontSize:9,fontFamily:MONO,marginTop:4},
  foundRssi:{fontSize:13,fontFamily:MONO,marginTop:6,fontWeight:'bold'},
  confirmQuestion:{color:'#00aa33',fontSize:12,fontFamily:MONO,textAlign:'center',marginBottom:12},
  foundButtons:{flexDirection:'row',gap:8,marginBottom:4},
  btnStart:{borderWidth:1,borderColor:GREEN,borderRadius:6,paddingVertical:14,alignItems:'center',marginBottom:8},
  btnStartText:{color:GREEN,fontSize:14,letterSpacing:3,fontFamily:MONO},
  btnClose:{borderWidth:1,borderColor:'#003310',borderRadius:6,paddingVertical:10,alignItems:'center'},
  btnCloseText:{color:'#005520',fontSize:11,fontFamily:MONO},
  btnRetry:{flex:1,borderWidth:1,borderColor:'#ffaa00',borderRadius:6,paddingVertical:11,alignItems:'center'},
  btnRetryText:{color:'#ffaa00',fontSize:11,fontFamily:MONO},
  btnConfirm:{flex:1,borderWidth:1,borderColor:GREEN,borderRadius:6,paddingVertical:11,alignItems:'center',backgroundColor:'#001a00'},
  btnConfirmText:{color:GREEN,fontSize:11,fontFamily:MONO},
  failedText:{color:'#ff4444',fontSize:11,fontFamily:MONO,textAlign:'center',marginBottom:16,lineHeight:18},
});
