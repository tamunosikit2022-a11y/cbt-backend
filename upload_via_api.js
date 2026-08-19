const fs = require('fs');

const SUPABASE_URL = 'https://dojnhyrqvaodguomritm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRvam5oeXJxdmFvZGd1b21yaXRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5NzY0NzEsImV4cCI6MjA5NDU1MjQ3MX0.S5km44Hh-cjAAmMzKhT6zeGHw9epTJlJphGkdd1ZTkM';

async function upload() {
  const raw = fs.readFileSync('all_questions_5k.json', 'utf8');
  const { questions } = JSON.parse(raw);
  console.log(`📚 Loaded ${questions.length} questions`);

  const batchSize = 100;
  let uploaded = 0;

  for (let i = 0; i < questions.length; i += batchSize) {
    const batch = questions.slice(i, i + batchSize);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/questions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(batch)
    });

    if (res.ok) {
      uploaded += batch.length;
      console.log(`✅ Uploaded ${uploaded}/${questions.length}`);
    } else {
      const err = await res.text();
      console.error(`❌ Error at batch ${i}:`, err);
      break;
    }
  }
  console.log('🎉 Done!');
}

upload().catch(console.error);