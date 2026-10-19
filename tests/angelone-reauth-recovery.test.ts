import { strict as assert } from 'assert';
import { AngelOneSessionStore } from '../server/brokers/angelone/sessionStore';
import { liveAngelOneAdapter } from '../server/brokers/angelone/liveAdapter';
import { DEFAULT_ANGELONE_ACCOUNT_ID } from '../src/types/risk';

async function runReauthRecoveryVerificationSuite() {
  console.log('================================================================');
  console.log('MonkFirewall2: Angel One Reauthentication Recovery Test Suite');
  console.log('================================================================\n');

  AngelOneSessionStore.enableMockStoreForTesting(true);

  const userId = 'user_reauth_recovery_777';
  const accountId = DEFAULT_ANGELONE_ACCOUNT_ID; // 'acc_mt_angelone_default'
  const apiKey = 'REAUTH_API_KEY_99999';

  // Mock SmartAPI fetch handler
  liveAngelOneAdapter.setFetchHandler(async (input: any) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/loginByPassword')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: true,
          data: { jwtToken: 'Bearer mock_reauth_jwt_token_over_20_chars_long' },
        }),
      } as any;
    }
    if (url.includes('/getRMS')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: true,
          data: {
            net: '150000.00',
            availablecash: '120000.00',
            availableintradaypayin: '30000.00',
            utilisedamount: '0.00',
          },
        }),
      } as any;
    }
    if (url.includes('/getPosition')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: true,
          data: [
            {
              exchange: 'NFO',
              tradingsymbol: 'NIFTY26OCT24500CE',
              producttype: 'CARRYFORWARD',
              netqty: '50',
              avgprice: '120.0',
              ltp: '145.0',
              pnl: '1250.0',
              symboltoken: '45001',
            },
          ],
        }),
      } as any;
    }
    return { ok: false, status: 400, json: async () => ({}) } as any;
  });

  // --------------------------------------------------------------------------
  // STEP 1: Simulate Invalidation / Expired Session State
  // --------------------------------------------------------------------------
  console.log('[Step 1] Initial Invalidated Session Setup');
  {
    await AngelOneSessionStore.saveApiKey(userId, apiKey, accountId);
    await AngelOneSessionStore.invalidateSession(userId, undefined, accountId);
    const initStatus = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: accountId });
    assert.equal(initStatus.status, 'AUTHENTICATION_REQUIRED', 'Initial state must be AUTHENTICATION_REQUIRED');
    assert.equal(initStatus.authenticated, false);
    console.log('  ✓ Initial state confirmed: AUTHENTICATION_REQUIRED');
  }

  // --------------------------------------------------------------------------
  // STEP 2: Execute Reauthentication Flow (POST /api/broker/angelone/live/auth/session)
  // --------------------------------------------------------------------------
  console.log('\n[Step 2] Executing Reauthentication (liveAngelOneAdapter.authenticate)');
  {
    const authRes = await liveAngelOneAdapter.authenticate(
      userId,
      {
        apiKey,
        clientCode: 'CLIENT_REAUTH_123',
        password: 'Password123',
        totp: '654321',
      },
      { connectionId: accountId }
    );

    assert.equal(authRes.success, true, 'Reauthentication must succeed');
    assert.ok(authRes.session?.expiresAt, 'Session expiresAt must be defined');
    console.log('  ✓ SmartAPI login succeeded and session created');

    // Verify Firestore session persistence & decryption
    const loadedSession = await AngelOneSessionStore.loadSession(userId, { connectionId: accountId });
    assert.ok(loadedSession, 'Session must exist in store');
    assert.equal(loadedSession?.authState, 'AUTHENTICATED', 'Session authState must be AUTHENTICATED');
    assert.equal(loadedSession?.accessToken, 'mock_reauth_jwt_token_over_20_chars_long', 'Access token decrypted correctly');
    console.log('  ✓ Session stored and decrypted successfully');

    // Verify API Key availability
    const loadedApiKey = await AngelOneSessionStore.loadApiKey(userId, accountId);
    assert.equal(loadedApiKey, apiKey, 'API key stored and decrypted correctly');
    console.log('  ✓ API key stored and decrypted successfully');
  }

  // --------------------------------------------------------------------------
  // STEP 3: Verify getConnectionStatus Clears authRequiredUsers & Returns AUTHENTICATED
  // --------------------------------------------------------------------------
  console.log('\n[Step 3] Post-Reauth Connection Status Verification');
  {
    const postStatus = await liveAngelOneAdapter.getConnectionStatus(userId, { connectionId: accountId });
    assert.equal(postStatus.status, 'AUTHENTICATED', 'Connection status must be AUTHENTICATED');
    assert.equal(postStatus.authenticated, true, 'authenticated flag must be true');
    assert.equal(postStatus.authenticationRequired, false, 'authenticationRequired must be false');
    console.log('  ✓ Connection status confirmed: AUTHENTICATED');
  }

  // --------------------------------------------------------------------------
  // STEP 4: Subsequent Capital Request Verification
  // --------------------------------------------------------------------------
  console.log('\n[Step 4] Subsequent Capital Endpoint Verification');
  {
    const capital = await liveAngelOneAdapter.getCapital(userId, { connectionId: accountId });
    assert.equal(capital.connectionStatus, 'AUTHENTICATED', 'Capital response connectionStatus must be AUTHENTICATED');
    assert.equal(capital.netBalance, 150000, 'Net balance matches SmartAPI /getRMS payload');
    assert.equal(capital.availableCash, 120000, 'Available cash matches payload');
    assert.equal(capital.currency, 'INR', 'Currency is INR');
    console.log('  ✓ Capital request returned live balance successfully');
  }

  // --------------------------------------------------------------------------
  // STEP 5: Subsequent Positions Request Verification
  // --------------------------------------------------------------------------
  console.log('\n[Step 5] Subsequent Positions Endpoint Verification');
  {
    const positions = await liveAngelOneAdapter.getPositions(userId, { connectionId: accountId });
    assert.equal(positions.length, 1, 'Should return 1 normalized position');
    assert.equal(positions[0].tradingsymbol, 'NIFTY26OCT24500CE');
    assert.equal(positions[0].pnl, 1250);
    console.log('  ✓ Positions request returned live positions successfully');
  }

  console.log('\n================================================================');
  console.log('ALL REAUTHENTICATION RECOVERY VERIFICATION STEPS PASSED (5/5)');
  console.log('================================================================\n');
}

runReauthRecoveryVerificationSuite().catch((err) => {
  console.error('Reauth Recovery Verification Suite Failed:', err);
  process.exit(1);
});
