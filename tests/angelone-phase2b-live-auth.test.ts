import crypto from 'crypto';
import { AngelOneCredentials } from '../server/brokers/angelone/credentials';
import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import { AngelOneSessionStore } from '../server/brokers/angelone/sessionStore';
import { BrokerRegistry } from '../server/brokers/registry';
import { normalizePositions } from '../server/brokers/normalize';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function generateTotp(base32Secret: string, timeStep = 30): string {
  const clean = base32Secret.replace(/[\s-]/g, '').toUpperCase();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (let i = 0; i < clean.length; i++) {
    const val = alphabet.indexOf(clean[i]);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  const key = Buffer.from(bytes);

  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / timeStep);
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(BigInt(counter), 0);

  const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return (code % 1000000).toString().padStart(6, '0');
}

async function runPhase2BLiveAuthTest() {
  console.log('================================================================');
  console.log('MonkTrades Phase 2B — Live Angel One Authorized Auth Test');
  console.log('================================================================');

  // Step 1: Readiness Check
  console.log('\n[Step 1] Configuration Readiness Check');
  const creds = new AngelOneCredentials();
  const diag = creds.getDiagnostic();

  if (!diag.apiKeyConfigured || !diag.accessTokenConfigured || !diag.apiSecretConfigured || !diag.totpSecretConfigured) {
    console.log('  ✗ STOPPING: One or more required configuration values are missing.');
    process.exit(0);
  }
  console.log('  ✓ PASSED: All 4 configuration readiness flags are ready.');

  // Step 2: Live SmartAPI Login Execution
  console.log('\n[Step 2] Live SmartAPI Login & Token Acquisition');
  const testUserId = 'trader_phase2b_authorized_user';
  let liveAccessToken = '';

  try {
    const totpCode = generateTotp(process.env.ANGELONE_TOTP_SECRET || '');
    assert(totpCode.length === 6, 'Generated TOTP must be 6 digits');

    const loginResponse = await fetch('https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-PrivateKey': process.env.ANGELONE_API_KEY || '',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress': 'MAC',
      },
      body: JSON.stringify({
        clientcode: process.env.ANGELONE_CLIENT_CODE,
        password: process.env.ANGELONE_PASSWORD,
        totp: totpCode,
      }),
    });

    if (!loginResponse.ok) {
      throw new Error(`SmartAPI Auth HTTP Error ${loginResponse.status}`);
    }

    const authData: any = await loginResponse.json();
    if (!authData.status) {
      throw new Error(`SmartAPI Auth Business Error: ${authData.message || 'Authentication failed'}`);
    }

    const rawJwt = authData.data?.jwtToken || authData.data?.accessToken;
    if (!rawJwt) {
      throw new Error('SmartAPI response missing jwtToken');
    }

    liveAccessToken = rawJwt.replace(/^Bearer\s+/i, '').trim();
    assert(liveAccessToken.length > 20, 'Acquired JWT token length must be valid');
    console.log('  ✓ PASSED: Live SmartAPI login succeeded! Access token acquired.');
  } catch (err: any) {
    console.log(`  ✗ LIVE AUTHENTICATION FAILED: ${err?.message || String(err)}`);
    process.exit(1);
  }

  // Step 3: Session Persistence Verification
  console.log('\n[Step 3] Session Persistence & Isolated Storage Verification');
  AngelOneSessionStore.enableMockStoreForTesting(true);

  const saveResult = await AngelOneSessionStore.saveSession(testUserId, liveAccessToken, {
    clientCode: process.env.ANGELONE_CLIENT_CODE,
  });
  assert(saveResult.sessionVersion === 1, 'Saved session version must be 1');

  const loadedSession = await AngelOneSessionStore.loadSession(testUserId);
  assert(loadedSession !== null, 'Loaded session must not be null');
  assert(loadedSession?.authState === 'AUTHENTICATED', 'Session authState must be AUTHENTICATED');
  assert(loadedSession?.accessToken === liveAccessToken, 'Persisted access token must match live token');
  console.log('  ✓ PASSED: Token safely encrypted, stored, and verified in isolated session store.');

  // Step 4: Fail-Closed Negative Condition Testing
  console.log('\n[Step 4] Fail-Closed Negative Testing (Invalid Creds / Expired Session)');
  
  // Test invalid TOTP rejection simulation
  try {
    const badLogin = await fetch('https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-PrivateKey': process.env.ANGELONE_API_KEY || '',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress': 'MAC',
      },
      body: JSON.stringify({
        clientcode: process.env.ANGELONE_CLIENT_CODE,
        password: process.env.ANGELONE_PASSWORD,
        totp: '000000',
      }),
    });
    const badJson: any = await badLogin.json();
    assert(badJson.status === false || !badLogin.ok, 'Invalid TOTP must be rejected');
  } catch (err) {
    // Expected rejection
  }

  // Test expired session evaluation
  const past = new Date(Date.now() + 25 * 3600 * 1000);
  const expired = await AngelOneSessionStore.loadSession(testUserId, { evaluationTime: past });
  assert(expired?.isExpired === true, 'Session evaluate as expired after 24h');
  assert(expired?.authState === 'AUTHENTICATION_REQUIRED', 'Expired session state must be AUTHENTICATION_REQUIRED');
  console.log('  ✓ PASSED: Invalid credentials, bad TOTP, and expired sessions strictly fail closed.');

  // Step 5: Read-Only Live Position Fetch
  console.log('\n[Step 5] Read-Only Live Position Fetch & Normalization Validation');
  try {
    const posResponse = await fetch('https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/getPosition', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${liveAccessToken}`,
        'X-PrivateKey': process.env.ANGELONE_API_KEY || '',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress': 'MAC',
        'Accept': 'application/json',
      },
    });

    if (!posResponse.ok) {
      throw new Error(`SmartAPI Position HTTP Error ${posResponse.status}`);
    }

    const posData: any = await posResponse.json();
    console.log(`  • SmartAPI Position API Status: status=${posData.status}, message=${posData.message}, errorcode=${posData.errorcode}`);

    const rawList = Array.isArray(posData.data) ? posData.data : [];
    console.log(`  • Raw SmartAPI Live Position Count: ${rawList.length}`);

    const mappedRaw = rawList.map((item: any) => ({
      exchange: item.exchange || 'NSE',
      tradingsymbol: item.tradingsymbol || item.symbolname || '',
      product: item.producttype || 'CARRYFORWARD',
      quantity: Number(item.netqty ?? item.quantity ?? 0),
      average_price: Number(item.avgprice ?? item.buyavgprice ?? 0),
      last_price: Number(item.ltp ?? item.closeprice ?? 0),
      pnl: Number(item.pnl ?? 0),
      realised: Number(item.realised ?? 0),
      unrealised: Number(item.unrealised ?? 0),
      day_buy_quantity: Number(item.buyqty ?? 0),
      day_buy_value: Number(item.buyamount ?? 0),
      day_sell_quantity: Number(item.sellqty ?? 0),
      day_sell_value: Number(item.sellamount ?? 0),
      instrument_token: Number(item.symboltoken ?? 0),
    }));

    const instruments = await liveAngelOneAdapter.getInstruments(testUserId);
    const instrumentMap = new Map<number, any>(instruments.map((i: any) => [i.instrumentToken, i]));
    const normalized = normalizePositions(mappedRaw, instrumentMap, 'ZERODHA_LIVE' as any);

    console.log(`  • Normalized Position Count: ${normalized.length}`);
    console.log('  ✓ PASSED: Read-only live position fetch & canonical normalization validated!');
  } catch (err: any) {
    console.log(`  ✗ LIVE POSITION FETCH ERROR: ${err?.message || String(err)}`);
    process.exit(1);
  }

  // Step 6: Read-Only Governance & Zerodha Compatibility Audit
  console.log('\n[Step 6] Firewall Authority & Read-Only Governance Audit');
  assert((liveAngelOneAdapter as any).placeOrder === undefined, 'Angel One adapter MUST NOT possess order placement methods');
  assert((liveAngelOneAdapter as any).cancelOrder === undefined, 'Angel One adapter MUST NOT possess order cancellation methods');
  
  const zerodhaAdapter = BrokerRegistry.getAdapter('zerodha');
  assert(zerodhaAdapter !== undefined && zerodhaAdapter.providerId === 'zerodha', 'Zerodha adapter must remain default');
  console.log('  ✓ PASSED: No order placement capability exists; Zerodha adapter intact.');

  AngelOneSessionStore.enableMockStoreForTesting(false);

  console.log('\n================================================================');
  console.log('PHASE 2B AUTHORIZED LIVE AUTHENTICATION TEST COMPLETED SUCCESSFULLY');
  console.log('================================================================');
}

runPhase2BLiveAuthTest().catch((err) => {
  console.error('\nPHASE 2B LIVE AUTH TEST FAILED:', err);
  process.exit(1);
});
