// Fetch stored details and query state on load
chrome.storage.local.get(['userId', 'extensionToken', 'serverUrl'], async (data) => {
  const { userId, extensionToken, serverUrl } = data;
  const btnBack = document.getElementById('btn-back');
  
  if (serverUrl) {
    btnBack.href = serverUrl;
  } else {
    btnBack.href = 'http://localhost:3000';
  }

  if (!userId || !serverUrl) {
    document.getElementById('lock-time').innerText = 'Lock Active (Please log in to MonkTrades)';
    return;
  }

  try {
    const response = await fetch(`${serverUrl}/api/enforcement/broker`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userId,
        'x-extension-token': extensionToken || ''
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
        document.getElementById('description').innerText = 'Trading access in MonkTrades is restricted until ' + timeString + '.';
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
