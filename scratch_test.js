// Use native global fetch

async function test() {
  const loginUrl = 'http://localhost:5000/api/auth/login';
  const voiceUrl = 'http://localhost:5000/api/admin/voice-agent';

  console.log('Logging in as boss@ascentra.com...');
  const loginRes = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'boss@ascentra.com', password: 'Password123!' })
  });

  const loginData = await loginRes.json();
  if (!loginRes.ok) {
    console.error('Login failed:', loginData);
    return;
  }

  const token = loginData.token;
  console.log('Login successful. Token acquired.');

  const queries = [
    { name: 'Hello check', query: 'Hello, who are you and how are you doing?' },
    { name: 'David lookup', query: 'What is David doing?' },
    { name: 'Workload Suggestions', query: 'Do you have any suggestions for task assignments?' },
    { name: 'Business Report', query: 'Give me a report on Apex Solutions' },
    { name: 'General knowledge check', query: 'Can you tell me what 15 times 15 is?' }
  ];

  for (const item of queries) {
    console.log(`\n--- Testing Query: "${item.name}" (query: "${item.query}") ---`);
    const res = await fetch(voiceUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ query: item.query })
    });

    const data = await res.json();
    if (!res.ok) {
      console.error('Request failed:', data);
    } else {
      console.log('Response Speech Text:');
      console.log(data.speechText);
    }
  }
}

test().catch(err => console.error('Error testing:', err));
