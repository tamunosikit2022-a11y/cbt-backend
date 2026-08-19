/**
 * schoolAliases.js
 *
 * PROBLEM THIS SOLVES: normalizeSchoolName.js only fixes CASING
 * ("uniport" vs "UNIPORT" -> same string). It can't fix two students
 * typing genuinely different strings for the same school — e.g.
 * "uniport" vs "University of Port Harcourt" vs "UNIPH". Those need an
 * actual alias -> canonical-name lookup, which is what this file is.
 *
 * Canonical form follows the same "Full Name (ACRONYM)" convention
 * already used in migrations/cutoff_marks.sql, so a student's school
 * lines up with the cutoff tracker's institution names too.
 *
 * HOW TO EXTEND: this list can't realistically cover every Nigerian
 * secondary school or every tertiary institution on day one. When you
 * spot a new variant fragmenting a school in your data (the
 * diagnoseSchoolNames.js script will show you these), just add another
 * string to that school's `aliases` array — everything else (matching,
 * backfill) works off this list automatically, nothing else to touch.
 */

const SCHOOLS = [
  { canonical: "University of Port Harcourt (UNIPORT)",              aliases: ["uniport", "university of port harcourt", "university of port-harcourt", "uniph", "u port harcourt"] },
  { canonical: "University of Lagos (UNILAG)",                        aliases: ["unilag", "university of lagos"] },
  { canonical: "University of Ibadan (UI)",                           aliases: ["ui", "university of ibadan", "uni ibadan"] },
  { canonical: "Obafemi Awolowo University (OAU)",                    aliases: ["oau", "obafemi awolowo university", "ife", "great ife"] },
  { canonical: "University of Benin (UNIBEN)",                        aliases: ["uniben", "university of benin"] },
  { canonical: "University of Nigeria, Nsukka (UNN)",                 aliases: ["unn", "university of nigeria nsukka", "university of nigeria, nsukka", "nsukka"] },
  { canonical: "University of Ilorin (UNILORIN)",                     aliases: ["unilorin", "university of ilorin"] },
  { canonical: "University of Abuja (UNIABUJA)",                      aliases: ["uniabuja", "university of abuja"] },
  { canonical: "Ahmadu Bello University, Zaria (ABU)",                aliases: ["abu", "ahmadu bello university", "abu zaria"] },
  { canonical: "University of Jos (UNIJOS)",                          aliases: ["unijos", "university of jos"] },
  { canonical: "Federal University of Agriculture, Abeokuta (FUNAAB)",aliases: ["funaab", "federal university of agriculture abeokuta", "federal university of agriculture, abeokuta"] },
  { canonical: "Ladoke Akintola University of Technology (LAUTECH)",  aliases: ["lautech", "ladoke akintola university", "ladoke akintola university of technology"] },
  { canonical: "Bayero University Kano (BUK)",                        aliases: ["buk", "bayero university", "bayero university kano"] },
  { canonical: "Nnamdi Azikiwe University, Awka (UNIZIK)",            aliases: ["unizik", "nnamdi azikiwe university", "awka"] },
  { canonical: "Osun State University (UNIOSUN)",                     aliases: ["uniosun", "osun state university"] },
  { canonical: "Olabisi Onabanjo University (OOU)",                   aliases: ["oou", "olabisi onabanjo university", "ogun state university", "ogunstech"] },
  { canonical: "Lagos State University (LASU)",                       aliases: ["lasu", "lagos state university"] },
  { canonical: "Lagos State University of Science and Technology (LASUSTECH)", aliases: ["lasustech", "lagos state university of science and technology"] },
  { canonical: "Pan-Atlantic University (PAU)",                       aliases: ["pau", "pan atlantic university", "pan-atlantic university"] },
  { canonical: "Covenant University (CU)",                            aliases: ["covenant university", "covenant uni", "cu covenant"] },
  { canonical: "Babcock University",                                  aliases: ["babcock university", "babcock"] },
  { canonical: "Federal University of Technology, Akure (FUTA)",      aliases: ["futa", "federal university of technology akure", "federal university of technology, akure"] },
  { canonical: "Federal University of Technology, Owerri (FUTO)",     aliases: ["futo", "federal university of technology owerri", "federal university of technology, owerri"] },
  { canonical: "Rivers State University (RSU)",                       aliases: ["rsu", "rivers state university", "rsust"] },
  { canonical: "Imo State University (IMSU)",                         aliases: ["imsu", "imo state university"] },
  { canonical: "Abia State University (ABSU)",                        aliases: ["absu", "abia state university"] },
  { canonical: "Ebonyi State University (EBSU)",                      aliases: ["ebsu", "ebonyi state university"] },
  { canonical: "Delta State University (DELSU)",                      aliases: ["delsu", "delta state university"] },
  { canonical: "Ambrose Alli University (AAU)",                       aliases: ["aau", "ambrose alli university"] },
  { canonical: "National Open University of Nigeria (NOUN)",          aliases: ["noun", "national open university", "national open university of nigeria"] },
  { canonical: "University of Maiduguri (UNIMAID)",                   aliases: ["unimaid", "university of maiduguri"] },
  { canonical: "Usmanu Danfodiyo University, Sokoto (UDUS)",          aliases: ["udus", "usmanu danfodiyo university", "usmanu danfodiyo university sokoto"] },
  { canonical: "Michael Okpara University of Agriculture, Umudike (MOUAU)", aliases: ["mouau", "michael okpara university", "michael okpara university of agriculture"] },
  { canonical: "Federal University Ndufu-Alike (FUNAI)",              aliases: ["funai", "federal university ndufu alike", "federal university ndufu-alike"] },
  { canonical: "University of Calabar (UNICAL)",                      aliases: ["unical", "university of calabar"] },
  { canonical: "University of Uyo (UNIUYO)",                          aliases: ["uniuyo", "university of uyo"] },
  { canonical: "Ekiti State University (EKSU)",                       aliases: ["eksu", "ekiti state university"] },
];

// Build a flat lookup: normalized alias text -> canonical name
const ALIAS_LOOKUP = new Map();
for (const { canonical, aliases } of SCHOOLS) {
  for (const alias of aliases) {
    ALIAS_LOOKUP.set(alias.trim().toLowerCase(), canonical);
  }
  // The canonical name itself should also resolve to itself
  ALIAS_LOOKUP.set(canonical.trim().toLowerCase(), canonical);
}

/**
 * Resolves free-text school input to a canonical name when it matches a
 * known school (case-insensitive). Falls back to the case-normalized
 * input unchanged when there's no known match — e.g. secondary schools,
 * or universities not yet in the SCHOOLS list above.
 */
function resolveSchoolAlias(name, normalizeSchoolName) {
  if (!name) return null;
  const lookupKey = String(name).trim().toLowerCase().replace(/\s+/g, " ");
  const match = ALIAS_LOOKUP.get(lookupKey);
  if (match) return match;
  return normalizeSchoolName(name);
}

module.exports = { resolveSchoolAlias, SCHOOLS };
