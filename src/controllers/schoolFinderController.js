/**
 * schoolFinderController.js — Scholars Syndicate
 * JAMB cutoff scores, O'level (WAEC/NECO) requirements, distance-based search,
 * and pros/cons for major Nigerian universities.
 * Data curated from JAMB CAPS 2023–2025 records.
 */

const OLEVEL_GENERAL = ['English Language','Mathematics']; // baseline required by almost every course

const UNIVERSITIES = [
  // Federal Universities
  { id:'ui',     name:'University of Ibadan',                    state:'Oyo',       type:'Federal',  cutoff:200, website:'https://www.ui.edu.ng',
    lat:7.4432, lng:3.8997,
    pros:['Oldest & most prestigious Nigerian university','Strong research output & alumni network','Wide range of postgraduate programs'],
    cons:['Very competitive admission','Large student population, can feel impersonal','Hostel accommodation is limited'] },
  { id:'unilag', name:'University of Lagos',                     state:'Lagos',     type:'Federal',  cutoff:200, website:'https://www.unilag.edu.ng',
    lat:6.5158, lng:3.3964,
    pros:['Located in Lagos — strong internship & job access','Modern facilities & active student life','Strong business & law faculties'],
    cons:['High cost of living nearby','Traffic and commute can be tough','Very competitive cutoffs for top courses'] },
  { id:'oau',    name:'Obafemi Awolowo University',               state:'Osun',      type:'Federal',  cutoff:200, website:'https://oauife.edu.ng',
    lat:7.5181, lng:4.5284,
    pros:['Beautiful, spacious campus','Strong technology & agriculture programs','Active campus culture & societies'],
    cons:['Somewhat remote location','Occasional academic calendar disruptions','Limited postgraduate funding'] },
  { id:'unn',    name:'University of Nigeria Nsukka',             state:'Enugu',     type:'Federal',  cutoff:200, website:'https://www.unn.edu.ng',
    lat:6.8649, lng:7.3958,
    pros:['First indigenous Nigerian university','Strong humanities & social sciences','Affordable cost of living'],
    cons:['Infrastructure needs upgrades in places','Distance from major commercial hubs','Hostel space limited'] },
  { id:'abu',    name:'Ahmadu Bello University',                  state:'Kaduna',    type:'Federal',  cutoff:180, website:'https://www.abu.edu.ng',
    lat:11.1556, lng:7.6614,
    pros:['One of the largest campuses in Africa','Wide course offering across all faculties','Lower cutoff = easier entry for many courses'],
    cons:['Security concerns in the region at times','Very large population can mean overcrowding','Long distances between campus sections'] },
  { id:'uniben', name:'University of Benin',                      state:'Edo',       type:'Federal',  cutoff:180, website:'https://www.uniben.edu.ng',
    lat:6.4019, lng:5.6135,
    pros:['Strong medical & pharmacy programs','Vibrant student community','Good urban location with amenities nearby'],
    cons:['Admission can be delayed some years','Some departments are overcrowded','Hostel allocation is competitive'] },
  { id:'funaab', name:'Federal Univ. of Agriculture, Abeokuta',   state:'Ogun',      type:'Federal',  cutoff:180, website:'https://www.funaab.edu.ng',
    lat:7.2350, lng:3.4470,
    pros:['Top choice for agriculture-related courses','Close to Lagos for internships','Smaller, focused campus community'],
    cons:['Limited course range outside agric/science','Fewer social/entertainment options nearby','Smaller alumni network in non-agric fields'] },
  { id:'futa',   name:'Federal Univ. of Technology, Akure',       state:'Ondo',      type:'Federal',  cutoff:180, website:'https://www.futa.edu.ng',
    lat:7.3009, lng:5.1467,
    pros:['Strong engineering & technology focus','Modern labs for science courses','Decent campus security & organisation'],
    cons:['Limited arts/humanities options','Akure has fewer internship opportunities than Lagos','Cost of living rising in recent years'] },
  { id:'uniport',name:'University of Port Harcourt',              state:'Rivers',    type:'Federal',  cutoff:180, website:'https://www.uniport.edu.ng',
    lat:4.9006, lng:6.9100,
    pros:['Strong oil & gas-related programs','Good for engineering and geosciences','Active student union & sports'],
    cons:['Environmental/flooding concerns in some areas','High cost of living in Port Harcourt','Some courses have large class sizes'] },
  { id:'unijos', name:'University of Jos',                        state:'Plateau',   type:'Federal',  cutoff:180, website:'https://unijos.edu.ng',
    lat:9.8965, lng:8.8583,
    pros:['Cool climate, scenic campus','Strong arts and social sciences','Lower cost of living'],
    cons:['Past security issues in the region','Fewer tech/engineering specializations','Limited industry exposure locally'] },
  { id:'unilorin', name:'University of Ilorin',                   state:'Kwara',     type:'Federal',  cutoff:180, website:'https://www.unilorin.edu.ng',
    lat:8.4799, lng:4.5418,
    pros:['Known for academic discipline & punctual calendar','Strong health sciences programs','Affordable accommodation'],
    cons:['Strict rules may not suit everyone','Limited nightlife/entertainment','High competition for medical courses'] },
  { id:'uniabuja', name:'University of Abuja',                    state:'FCT',       type:'Federal',  cutoff:180, website:'https://uniabuja.edu.ng',
    lat:8.9870, lng:7.1700,
    pros:['Located in the capital — networking opportunities','Growing infrastructure investment','Central location for all regions'],
    cons:['Main campus is outside the city centre','Some faculties still developing','Hostel accommodation insufficient'] },
  { id:'mautech', name:'Modibbo Adama Univ. of Technology',       state:'Adamawa',   type:'Federal',  cutoff:160, website:'https://www.mautech.edu.ng',
    lat:9.3265, lng:12.4818,
    pros:['Lower cutoff — accessible for many science students','Focused technology curriculum','Low cost of living'],
    cons:['Remote location, far from major cities','Past regional security concerns','Limited course diversity'] },
  { id:'futminna', name:'Federal Univ. of Technology, Minna',     state:'Niger',     type:'Federal',  cutoff:160, website:'https://www.futminna.edu.ng',
    lat:9.6184, lng:6.5569,
    pros:['Strong engineering/technology focus','Lower cutoff than many federal unis','Reasonable cost of living'],
    cons:['Limited arts/humanities courses','Less industry presence locally','Infrastructure varies by department'] },
  { id:'uniuyo', name:'University of Uyo',                        state:'Akwa Ibom', type:'Federal',  cutoff:180, website:'https://uniuyo.edu.ng',
    lat:5.0377, lng:7.9128,
    pros:['Strong agriculture & health sciences','Calm, organised environment','Good for science-based courses'],
    cons:['Far from major commercial hubs','Fewer internship/industry links','Limited postgraduate funding'] },
  // State Universities
  { id:'lasu',  name:'Lagos State University',                    state:'Lagos',     type:'State',    cutoff:180, website:'https://lasu.edu.ng',
    lat:6.5346, lng:3.2876,
    pros:['Located in Lagos — strong job market access','Affordable for Lagos residents','Decent law & social sciences programs'],
    cons:['Indigene/non-indigene fee differences','Large class sizes in popular courses','Admission process can be slow'] },
  { id:'oou',   name:'Olabisi Onabanjo University',               state:'Ogun',      type:'State',    cutoff:160, website:'https://oouagoiwoye.edu.ng',
    lat:6.9038, lng:3.7136,
    pros:['Lower cutoff — accessible entry','Close to Lagos for opportunities','Good range of social science courses'],
    cons:['Infrastructure needs improvement','Indigene fee advantage favors Ogun residents','Limited science lab facilities'] },
  { id:'eksu',  name:'Ekiti State University',                    state:'Ekiti',     type:'State',    cutoff:160, website:'https://eksu.edu.ng',
    lat:7.6233, lng:5.2200,
    pros:['Lower cutoff for many courses','Calm environment for studying','Affordable accommodation'],
    cons:['Smaller alumni/industry network','Fewer course specializations','Limited entertainment options'] },
  { id:'rsust', name:'Rivers State Univ. of Sci. & Tech.',        state:'Rivers',    type:'State',    cutoff:160, website:'https://rsust.edu.ng',
    lat:4.8242, lng:6.9925,
    pros:['Good for science & technology courses','Located in Port Harcourt — oil & gas exposure','Lower cutoff than federal options'],
    cons:['Non-indigene fees significantly higher','Some facilities need upgrades','Class sizes can be large'] },
  { id:'delsu', name:'Delta State University',                    state:'Delta',     type:'State',    cutoff:160, website:'https://delsu.edu.ng',
    lat:6.1875, lng:6.7306,
    pros:['Wide course range','Affordable for Delta residents','Active student community'],
    cons:['Multiple campuses can complicate logistics','Non-indigene fees higher','Infrastructure varies by campus'] },
  // Private Universities
  { id:'covenant', name:'Covenant University',                    state:'Ogun',      type:'Private',  cutoff:200, website:'https://covenantuniversity.edu.ng',
    lat:6.6713, lng:3.1581,
    pros:['Excellent facilities & strict academic discipline','Strong employability record','Modern hostels & campus life'],
    cons:['High tuition fees','Strict rules (dress code, curfews)','Religious affiliation shapes campus culture'] },
  { id:'babcock', name:'Babcock University',                      state:'Ogun',      type:'Private',  cutoff:160, website:'https://babcock.edu.ng',
    lat:6.8917, lng:3.7180,
    pros:['Strong medical & health sciences','Good campus security & facilities','Lower cutoff than Covenant'],
    cons:['High tuition fees','Strict religious-based rules','Limited weekend off-campus freedom'] },
  { id:'pan-atlantic', name:'Pan-Atlantic University',            state:'Lagos',     type:'Private',  cutoff:180, website:'https://pau.edu.ng',
    lat:6.4474, lng:3.5550,
    pros:['Top-tier business school (Lagos Business School link)','Strong industry connections','Small class sizes, personalized attention'],
    cons:['Very high tuition fees','Limited course range (mostly business/media/IT)','Highly selective admissions process'] },
  { id:'landmark', name:'Landmark University',                    state:'Kwara',     type:'Private',  cutoff:160, website:'https://lmu.edu.ng',
    lat:8.1339, lng:4.7378,
    pros:['Strong agriculture & entrepreneurship focus','Modern campus facilities','Scholarship opportunities available'],
    cons:['High tuition fees','Remote location','Strict campus rules'] },
  { id:'afe-babalola', name:'Afe Babalola University',            state:'Ekiti',     type:'Private',  cutoff:160, website:'https://abuad.edu.ng',
    lat:7.6219, lng:5.2350,
    pros:['Strong law and engineering programs','Modern, well-equipped campus','Good security and facilities'],
    cons:['High tuition fees','Strict academic and disciplinary policies','Smaller social scene than urban schools'] },
];

const COURSES = [
  { id:'medicine',    name:'Medicine & Surgery',           subjects:['Biology','Chemistry','Physics or Mathematics'], olevel:['Biology','Chemistry','Physics','English Language','Mathematics'], min_score:280, competitive:true },
  { id:'law',         name:'Law',                          subjects:['Literature in English','Government','Any Social Science'], olevel:['Literature in English','Government','English Language','Mathematics'], min_score:240, competitive:true },
  { id:'engineering', name:'Engineering (all branches)',   subjects:['Mathematics','Physics','Chemistry'],           olevel:['Mathematics','Physics','Chemistry','English Language'], min_score:200, competitive:false },
  { id:'pharmacy',    name:'Pharmacy',                     subjects:['Chemistry','Biology','Mathematics or Physics'], olevel:['Chemistry','Biology','Physics','Mathematics','English Language'], min_score:240, competitive:true },
  { id:'nursing',     name:'Nursing Science',              subjects:['Biology','Chemistry','Physics or Mathematics'], olevel:['Biology','Chemistry','Physics','Mathematics','English Language'], min_score:200, competitive:false },
  { id:'accounting',  name:'Accounting',                   subjects:['Mathematics','Economics','Any Social Science'], olevel:['Mathematics','Economics','English Language'], min_score:180, competitive:false },
  { id:'economics',   name:'Economics',                    subjects:['Mathematics','Economics','Any Social Science'], olevel:['Mathematics','Economics','English Language'], min_score:180, competitive:false },
  { id:'cs',          name:'Computer Science',             subjects:['Mathematics','Physics','Any Science/Art'],     olevel:['Mathematics','Physics','English Language'], min_score:180, competitive:false },
  { id:'biology',     name:'Biology / Biochemistry',       subjects:['Biology','Chemistry','Mathematics or Physics'], olevel:['Biology','Chemistry','Mathematics','English Language'], min_score:180, competitive:false },
  { id:'english',     name:'English Language & Lit.',      subjects:['Literature in English','Any two Arts/Social'], olevel:['Literature in English','English Language','Any 3 subjects'], min_score:180, competitive:false },
  { id:'mass-comm',   name:'Mass Communication',           subjects:['English Language','Government or History','Any two subjects'], olevel:['English Language','Any 4 subjects'], min_score:180, competitive:false },
  { id:'architecture', name:'Architecture',                subjects:['Mathematics','Physics','Any Science/Art'],     olevel:['Mathematics','Physics','Fine Art or Drawing','English Language'], min_score:200, competitive:false },
  { id:'agric',       name:'Agricultural Science',         subjects:['Biology','Chemistry or Physics','Mathematics'], olevel:['Biology','Chemistry','Mathematics','English Language'], min_score:160, competitive:false },
  { id:'education',   name:'Education (any subject)',      subjects:['Relevant to teaching subject'],                olevel:["Relevant O'level subjects"], min_score:160, competitive:false },
  { id:'banking',     name:'Banking & Finance',            subjects:['Mathematics','Economics','Any Social Science'], olevel:['Mathematics','Economics','English Language'], min_score:180, competitive:false },
];

// Haversine distance in km
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

function withDistance(list, lat, lng) {
  if (lat == null || lng == null || lat === '' || lng === '') return list;
  return list.map(u => ({ ...u, distance_km: distanceKm(parseFloat(lat), parseFloat(lng), u.lat, u.lng) }));
}

// ── SEARCH SCHOOLS ────────────────────────────────────────
exports.searchSchools = async (req, res) => {
  const { q, state, type, min_score, lat, lng } = req.query;
  const score = parseInt(min_score) || 0;

  let results = UNIVERSITIES;
  if (q)     results = results.filter(u => u.name.toLowerCase().includes(q.toLowerCase()) || u.state.toLowerCase().includes(q.toLowerCase()));
  if (state) results = results.filter(u => u.state.toLowerCase() === state.toLowerCase());
  if (type)  results = results.filter(u => u.type.toLowerCase() === type.toLowerCase());
  if (score) results = results.filter(u => u.cutoff <= score);

  results = withDistance(results, lat, lng);
  if (lat && lng) results = [...results].sort((a,b) => a.distance_km - b.distance_km);

  res.json({ schools: results, total: results.length });
};

// ── GET SCHOOL DETAIL ────────────────────────────────────
exports.getSchool = async (req, res) => {
  const { lat, lng } = req.query;
  const school = UNIVERSITIES.find(u => u.id === req.params.id);
  if (!school) return res.status(404).json({ error: 'School not found' });
  const withD = withDistance([school], lat, lng)[0];
  res.json({ school: withD, courses: COURSES.filter(c => c.min_score <= school.cutoff + 60) });
};

// ── GET ALL COURSES ───────────────────────────────────────
exports.getCourses = async (req, res) => {
  const { q } = req.query;
  let results = COURSES;
  if (q) results = results.filter(c => c.name.toLowerCase().includes(q.toLowerCase()));
  res.json({ courses: results });
};

// ── CHECK ELIGIBILITY ─────────────────────────────────────
exports.checkEligibility = async (req, res) => {
  const { score, course_id, lat, lng } = req.body;
  if (!score || !course_id) return res.status(400).json({ error: 'score and course_id required' });

  const course  = COURSES.find(c => c.id === course_id);
  if (!course)  return res.status(404).json({ error: 'Course not found' });

  let eligible = UNIVERSITIES.filter(u => u.cutoff <= parseInt(score) && course.min_score <= parseInt(score));
  let marginal = UNIVERSITIES.filter(u => u.cutoff > parseInt(score) && u.cutoff <= parseInt(score) + 30 && course.min_score <= parseInt(score) + 30);

  eligible = withDistance(eligible, lat, lng);
  marginal = withDistance(marginal, lat, lng);
  if (lat && lng) {
    eligible = [...eligible].sort((a,b) => a.distance_km - b.distance_km);
    marginal = [...marginal].sort((a,b) => a.distance_km - b.distance_km);
  }

  res.json({ course, eligible, marginal, score: parseInt(score), general_olevel: OLEVEL_GENERAL });
};

// ── GET STATES ───────────────────────────────────────────
exports.getStates = async (_req, res) => {
  const states = [...new Set(UNIVERSITIES.map(u => u.state))].sort();
  res.json({ states });
};
