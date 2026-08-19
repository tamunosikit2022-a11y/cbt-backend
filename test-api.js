const http = require('http');

const BASE_URL = 'http://localhost:5000';

const tests = [
  { name: '🏥 Health Check', endpoint: '/api/health', auth: false },
  { name: '📚 Get Subjects', endpoint: '/api/exam/subjects?exam_type=JAMB', auth: false },
  { name: '📝 Get History', endpoint: '/api/exam/history', auth: true },
  { name: '🎯 Daily Challenge', endpoint: '/innovations/challenge/today', auth: true },
  { name: '🏆 Leaderboard', endpoint: '/exam/leaderboard?period=all', auth: false }
];

async function makeRequest(endpoint, needAuth) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'localhost',
      port: 5000,
      path: endpoint,
      method: 'GET',
      headers: needAuth ? {
        'Authorization': 'Bearer test-token-123'
      } : {}
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300 });
      });
    });
    
    req.on('error', (err) => {
      resolve({ status: 0, ok: false, error: err.message });
    });
    
    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ status: 0, ok: false, error: 'Timeout' });
    });
    
    req.end();
  });
}

async function runTests() {
  console.log('\n🔍 TESTING API ENDPOINTS\n');
  console.log('='.repeat(50));
  
  let passed = 0;
  let failed = 0;
  
  for (const test of tests) {
    process.stdout.write(`Testing ${test.name}... `);
    const result = await makeRequest(test.endpoint, test.auth);
    
    if (result.ok) {
      console.log(`✅ ${result.status}`);
      passed++;
    } else {
      console.log(`❌ ${result.status || 'ERROR'} - ${result.error || 'Failed'}`);
      failed++;
    }
  }
  
  console.log('='.repeat(50));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  
  if (failed > 0) {
    console.log('💡 TIPS:');
    console.log('  1. Make sure backend is running on port 5000');
    console.log('  2. Check database connection');
    console.log('  3. Verify environment variables');
  }
}

// Run the tests
runTests();