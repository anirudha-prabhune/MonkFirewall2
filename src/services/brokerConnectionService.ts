import { doc, getDoc, setDoc, onSnapshot, collection, getDocs } from 'firebase/firestore';
import { db } from './firebase';
import { BrokerConnection } from '../types/broker';
import { handleFirestoreError, OperationType } from './firestoreErrors';
import { DEFAULT_ACCOUNT_ID } from '../types/risk';

export async function getBrokerConnection(userId: string): Promise<BrokerConnection | null> {
  const path = `users/${userId}/brokerConnections/primary`;
  try {
    const docRef = doc(db, 'users', userId, 'brokerConnections', 'primary');
    const snapshot = await getDoc(docRef);
    if (snapshot.exists()) {
      return snapshot.data() as BrokerConnection;
    }
    return null;
  } catch (error: any) {
    const msg = (error?.message || String(error)).toLowerCase();
    if (msg.includes('client is offline') || msg.includes('unavailable') || msg.includes('failed to get document')) {
      console.warn(`getBrokerConnection offline for ${userId}; returning null`);
      return null;
    }
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function getBrokerConnections(userId: string): Promise<Array<{ connectionId: string; connection: BrokerConnection }>> {
  if (userId.startsWith('mock-')) {
    return [
      {
        connectionId: DEFAULT_ACCOUNT_ID,
        connection: {
          broker: 'zerodha',
          status: 'CONNECTED',
          userId,
          connectedAt: new Date().toISOString(),
        },
      },
      {
        connectionId: 'acc_zerodha_secondary',
        connection: {
          broker: 'zerodha',
          status: 'CONNECTED',
          userId,
          connectedAt: new Date().toISOString(),
        },
      },
    ];
  }

  try {
    const colRef = collection(db, 'users', userId, 'brokerConnections');
    const snapshot = await getDocs(colRef);
    const list: Array<{ connectionId: string; connection: BrokerConnection }> = [];
    snapshot.forEach((docSnap) => {
      list.push({
        connectionId: docSnap.id,
        connection: docSnap.data() as BrokerConnection,
      });
    });

    if (list.length === 0) {
      list.push({
        connectionId: DEFAULT_ACCOUNT_ID,
        connection: {
          broker: 'zerodha',
          status: 'DISCONNECTED',
          userId,
        },
      });
    }
    return list;
  } catch (error) {
    return [
      {
        connectionId: DEFAULT_ACCOUNT_ID,
        connection: {
          broker: 'zerodha',
          status: 'DISCONNECTED',
          userId,
        },
      },
    ];
  }
}

export function subscribeBrokerConnection(
  userId: string,
  onUpdate: (conn: BrokerConnection | null) => void,
  onError?: (err: Error) => void
): () => void {
  const path = `users/${userId}/brokerConnections/primary`;
  const docRef = doc(db, 'users', userId, 'brokerConnections', 'primary');

  return onSnapshot(
    docRef,
    (snapshot) => {
      if (snapshot.exists()) {
        onUpdate(snapshot.data() as BrokerConnection);
      } else {
        onUpdate(null);
      }
    },
    (error) => {
      if (onError) onError(error);
      handleFirestoreError(error, OperationType.GET, path);
    }
  );
}

export async function setInitialBrokerStatus(userId: string, broker: 'zerodha' | 'mock', status: 'DISCONNECTED' | 'CONNECTED'): Promise<BrokerConnection> {
  const path = `users/${userId}/brokerConnections/primary`;
  try {
    const docRef = doc(db, 'users', userId, 'brokerConnections', 'primary');
    const connectionData: BrokerConnection = {
      broker,
      status,
      userId,
      connectedAt: new Date().toISOString(),
      lastSyncAt: new Date().toISOString(),
    };
    await setDoc(docRef, connectionData, { merge: true });
    return connectionData;
  } catch (error: any) {
    const msg = (error?.message || String(error)).toLowerCase();
    if (msg.includes('client is offline') || msg.includes('unavailable') || msg.includes('failed to get document')) {
      console.warn(`setInitialBrokerStatus offline for ${userId}; returning local status`);
      return {
        broker,
        status,
        userId,
        connectedAt: new Date().toISOString(),
        lastSyncAt: new Date().toISOString(),
      };
    }
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}
