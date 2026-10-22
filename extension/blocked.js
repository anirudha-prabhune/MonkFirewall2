// Fetch stored details and query state on load
(function() {
  let broker = 'zerodha';
  let accountId = 'acc_mt_zerodha_default';
  try {
    const searchStr = (typeof window !== 'undefined' && window.location && window.location.search) ? window.location.search : '';
    const matchBroker = searchStr.match(/[?&]broker=([^&]+)/i);
    if (matchBroker && matchBroker[1]) {
      broker = decodeURIComponent(matchBroker[1]).toLowerCase();
    }
    const matchAccount = searchStr.match(/[?&]account=([^&]+)/i);
    if (matchAccount && matchAccount[1]) {
      accountId = decodeURIComponent(matchAccount[1]);
    } else {
      accountId = broker === 'angelone' ? 'acc_mt_angelone_default' : 'acc_mt_zerodha_default';
    }
  } catch (e) {
    // Fallback defaults
  }
  const brokerLabel = broker === 'angelone' ? 'Angel One' : 'Kite Zerodha';

  const titleEl = document.getElementById('title');
  if (titleEl) {
    titleEl.innerText = `${brokerLabel} Trading Locked`;
  }

  chrome.storage.local.get(['userId', 'extensionToken', 'serverUrl'], async (data) => {
    const { userId, extensionToken, serverUrl } = data || {};
    const btnBack = document.getElementById('btn-back');
    
    if (serverUrl) {
      btnBack.href = serverUrl;
    } else {
      btnBack.href = 'http://localhost:3000';
    }

    if (!userId || !serverUrl) {
      document.getElementById('lock-time').innerText = 'Lock Active (Please log in to ArthaKavach)';
      return;
    }

    try {
      const queryStr = `broker=${encodeURIComponent(broker)}&accountId=${encodeURIComponent(accountId)}`;
      const response = await fetch(`${serverUrl}/api/enforcement/broker?${queryStr}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': userId,
          'x-extension-token': extensionToken || '',
          'x-broker': broker,
          'x-account-id': accountId
        }
      });

      if (response.ok) {
        const contract = await response.json();
        if (contract && contract.lockUntil) {
          const timeString = new Date(contract.lockUntil).toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
          }) + ' IST';
          
          document.getElementById('lock-time').innerText = 'Restricted until ' + timeString;
          document.getElementById('description').innerText = 'Trading access in ArthaKavach is restricted until ' + timeString + '.';
        } else {
          document.getElementById('lock-time').innerText = 'Active Lock (Time unavailable)';
        }
      } else {
        document.getElementById('lock-time').innerText = 'Active Lock (State unavailable)';
      }
    } catch (err) {
      document.getElementById('lock-time').innerText = 'Active Lock (Connection offline)';
    }
  });
})();
