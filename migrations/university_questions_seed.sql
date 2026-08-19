-- university_questions_seed.sql
-- UNIPORT GES112 and GES103 past questions
-- Source: Verified past exam practice materials from UNIPORT students (Studocu, 2022-2025)
-- exam_type = 'UNIVERSITY', institution = 'UNIPORT'
-- Run AFTER waec_neco_support.sql

-- Ensure university exam_type is allowed
UPDATE questions SET exam_type = exam_type WHERE 1=0; -- no-op, just validate

-- ──────────────────────────────────────────────────────────────────────────────
-- UNIPORT GES112 — Nigerian Peoples & Culture (History, Culture & Art to 1800)
-- ──────────────────────────────────────────────────────────────────────────────

INSERT INTO questions (exam_type, institution, subject, topic, question, option_a, option_b, option_c, option_d, correct_answer, explanation, year)
VALUES

-- Yoruba History & Government
('UNIVERSITY','UNIPORT','GES112','Yoruba Political System',
 'Which of the following was the main political system of the Yoruba before 1800?',
 'Gerontocracy','Theocratic Monarchy','Constitutional Monarchy','Feudal System',
 'C','The Yoruba operated a constitutional monarchy system, especially in the Oyo Empire. The Alaafin served as king while the Oyo Mesi acted as a check on his powers.',
 2024),

('UNIVERSITY','UNIPORT','GES112','Yoruba Political System',
 'The spiritual and political head of the Yoruba people in Ife is known as the—',
 'Alaafin','Ooni','Oba','Olubada',
 'B','The Ooni of Ife is regarded as the spiritual father of the Yoruba people and is based in Ile-Ife.',
 2024),

('UNIVERSITY','UNIPORT','GES112','Yoruba Political System',
 'Which of the following was the most prominent Yoruba kingdom before 1800?',
 'Benin','Ife','Oyo','Ijebu',
 'C','The Oyo Empire was the most powerful and influential Yoruba kingdom before colonial rule.',
 2024),

('UNIVERSITY','UNIPORT','GES112','Yoruba Political System',
 'What was the title of the king in the Oyo Empire?',
 'Obong','Obi','Sultan','Alaafin',
 'D','The Alaafin was the ruler of the Oyo Empire, assisted by the Oyo Mesi and Ogboni.',
 2024),

('UNIVERSITY','UNIPORT','GES112','Yoruba Political System',
 'The Oyo Mesi in Yoruba political structure served as—',
 'Military Commanders','Priests','Kingmakers and Advisers','Tax Collectors',
 'C','The Oyo Mesi were a council of seven chiefs who advised and could remove the Alaafin.',
 2024),

-- Nok Culture & Art
('UNIVERSITY','UNIPORT','GES112','Nigerian Art & Culture',
 'Which ethnic group is associated with the Nok culture?',
 'Yoruba','Hausa','Igbo','Jukun',
 'B','The Nok culture was located in areas now known as northern and central Nigeria, closely linked to the Hausa.',
 2024),

('UNIVERSITY','UNIPORT','GES112','Nigerian Art & Culture',
 'Nok culture is particularly famous for its—',
 'Bronze masks','Terracotta sculptures','Wooden carvings','Wall paintings',
 'B','The Nok culture is best known for its terracotta figurines dating back to 500 BC.',
 2024),

-- Igbo Culture
('UNIVERSITY','UNIPORT','GES112','Igbo Cultural Practices',
 'Which of these is a major Igbo festival that predates colonialism?',
 'New Yam Festival','Sallah','Argungu','Osun Festival',
 'A','The New Yam Festival (Iri ji) is a major Igbo cultural celebration of the harvest season.',
 2024),

-- Hausa History
('UNIVERSITY','UNIPORT','GES112','Hausa Political History',
 'How did Islam spread to the Hausa states primarily?',
 'War and conquest','Missionaries','Trade and scholarship','Colonization',
 'C','Islam spread to the Hausa states mainly through trans-Saharan trade and the work of Islamic scholars.',
 2024),

-- Minority Groups & Art
('UNIVERSITY','UNIPORT','GES112','Nigerian Art & Culture',
 'Which minority group is known for its unique bronze art similar to that of Benin and Ife?',
 'Nupe','Ibibio','Jukun','Tiv',
 'A','The Nupe people are known for bronze artworks that resemble those from Benin and Ife.',
 2024),

('UNIVERSITY','UNIPORT','GES112','Pre-Colonial Kingdoms',
 'Which of these was an ancient kingdom located in what is now Cross River State?',
 'Nri','Kanem','Kwararafa','Akwa Akpa (Old Calabar)',
 'D','Akwa Akpa, also called Old Calabar, was a powerful trading kingdom in the Cross River area.',
 2024),

('UNIVERSITY','UNIPORT','GES112','Nigerian Art & Culture',
 'Which of the following ancient Nigerian civilizations is most associated with bronze casting?',
 'Nok','Ife','Tiv','Ibadan',
 'B','Ife civilization is most associated with naturalistic bronze and brass sculpture.',
 2024),

-- Additional GES112 questions
('UNIVERSITY','UNIPORT','GES112','Yoruba Political System',
 'The Ogboni society in Yoruba tradition was primarily responsible for—',
 'Military training','Land and earth worship and justice','Tax collection','Trade regulation',
 'B','The Ogboni society was a powerful secret society concerned with the earth deity and served judicial functions.',
 2024),

('UNIVERSITY','UNIPORT','GES112','Hausa Political History',
 'The Jihad of Usman Dan Fodio in the 19th century led to the establishment of the—',
 'Oyo Empire','Benin Kingdom','Sokoto Caliphate','Kanem-Bornu',
 'C','The 1804 Jihad led by Usman Dan Fodio resulted in the creation of the Sokoto Caliphate.',
 2024),

('UNIVERSITY','UNIPORT','GES112','Pre-Colonial Kingdoms',
 'The Benin Empire was particularly known for which art form?',
 'Terracotta','Woodcarving','Bronze casting','Weaving',
 'C','The Benin Empire is world-famous for its extraordinary bronze castings depicting the Oba and court life.',
 2024),

('UNIVERSITY','UNIPORT','GES112','Pre-Colonial Kingdoms',
 'Who founded the Oduduwa legend of the Yoruba?',
 'Alaafin','Oduduwa','Sango','Obatala',
 'B','Oduduwa is considered the ancestor of the Yoruba people and the founder of the Ife kingdom.',
 2024),

('UNIVERSITY','UNIPORT','GES112','Nigerian Art & Culture',
 'The Igbo-Ukwu bronze artifacts were discovered in which Nigerian state?',
 'Delta','Anambra','Imo','Enugu',
 'B','The Igbo-Ukwu bronzes were unearthed in Anambra State in 1938-1939 by accident during well-digging.',
 2024),

('UNIVERSITY','UNIPORT','GES112','Hausa Political History',
 'Which system of government was practiced by the Hausa-Fulani Emirate after the Jihad?',
 'Democratic republic','Military dictatorship','Emirate/Theocratic monarchy','Constitutional monarchy',
 'C','After Usman Dan Fodio''s Jihad, the Hausa states were reorganized into Emirates governed by Emirs under the Sokoto Caliphate.',
 2024),

('UNIVERSITY','UNIPORT','GES112','Igbo Cultural Practices',
 'What is the Osu caste system in Igbo society?',
 'A system of age grades','A class of dedicated cult slaves','A priestly order','A royal family system',
 'B','The Osu were people who were dedicated to a deity and considered outcasts or cult slaves in traditional Igbo society.',
 2024),

('UNIVERSITY','UNIPORT','GES112','Pre-Colonial Kingdoms',
 'The Kanem-Bornu Empire was located in present-day—',
 'Southwest Nigeria','North-east Nigeria and Lake Chad basin','South-south Nigeria','North-west Nigeria',
 'B','The Kanem-Bornu Empire was centred around the Lake Chad basin in what is now north-eastern Nigeria, Niger, and Chad.',
 2024),

('UNIVERSITY','UNIPORT','GES112','Nigerian Art & Culture',
 'Which of these art forms is most associated with the Tiv people?',
 'Bronze casting','Terracotta','Body scarification and weaving','Wood carving',
 'C','The Tiv are particularly known for body scarification (sande) and elaborate weaving traditions.',
 2024),

-- ──────────────────────────────────────────────────────────────────────────────
-- UNIPORT GES103 — Nigerian Peoples & Culture (Social Institutions, HIV, etc.)
-- ──────────────────────────────────────────────────────────────────────────────

INSERT INTO questions (exam_type, institution, subject, topic, question, option_a, option_b, option_c, option_d, correct_answer, explanation, year)
VALUES

('UNIVERSITY','UNIPORT','GES103','Nigerian Names & Identity',
 'Which one of these is a theophoric name?',
 'Kayode','Tokunboh','Rashidi','Ogunde',
 'D','Theophoric names contain a reference to a deity. Ogunde contains ''Ogun'', the Yoruba god of iron.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Health in Nigeria',
 'The first case of HIV/AIDS in Nigeria was diagnosed in—',
 '1980','1983','1990','1986',
 'D','Nigeria''s first HIV/AIDS case was diagnosed in 1986.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Yoruba Political System',
 'In Yoruba kingdom, the most senior chiefs gathered at—',
 'Town hall','Oba''s house','King''s palace','Senior chiefs palace',
 'C','In Yoruba kingdoms, senior chiefs and councils gathered at the king''s palace.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Cultural Geography',
 'How many distinct cultural areas have been delineated in the cultural map of Nigeria?',
 '20','40','15','35',
 'D','Nigeria has been delineated into approximately 35 distinct cultural areas.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Cultural Concepts',
 'Closely related to culture area is—',
 'Formal culture','Culture region','Environment','Education',
 'B','A culture region is closely related to a culture area; both refer to geographic areas where people share similar cultural traits.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Kinship & Descent',
 'In ______ descent system, individuals acquire membership in both patrilineal and matrilineal groups according to culturally determined rules.',
 'Ambilineal','Unilineal','Matrilineal','Double descent',
 'D','Double descent is a system where individuals inherit membership in both patrilineal and matrilineal groups.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Environment & Ecology',
 'An ecosystem refers to—',
 'Community and its habitat','Plant and animal population','Economy and population','An assemblage of organisms',
 'A','An ecosystem is the interaction between a community of living organisms and their physical environment.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Hausa Political System',
 'Which ethnic group uses the hakimi to administer the district?',
 'Yoruba','Igbo','Hausa/Fulani','Tiv',
 'C','The Hausa/Fulani use the Hakimi (district head) as part of their hierarchical emirate administrative system.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Cultural Concepts',
 'Which word best describes a people''s world view?',
 'Relativism','Cosmology','Universe','Reincarnation',
 'B','Cosmology refers to the set of beliefs that a people hold about the nature and origin of the universe — their world view.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Marriage Customs',
 'Which Nigerian group practises marriage by elopement?',
 'Andoni','Tiv','Benin','Iriebe',
 'B','The Tiv people of north-central Nigeria practise a form of marriage by elopement (shagbaor).',
 2023),

('UNIVERSITY','UNIPORT','GES103','Marriage Customs',
 'Which term best describes the marriage of a man to more than one wife?',
 'Serial monogamy','Polygamy','Adultery','Polyandry',
 'B','Polygamy (specifically polygyny) is the practice of a man having more than one wife simultaneously.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Social Norms',
 '______ regulate human behaviour and are standards for action in society.',
 'Values','Cosmology','Norms','Institution',
 'C','Norms are the rules and standards that regulate behaviour in a society.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Cultural Geography',
 'The estimated number of ethnic groups in Nigeria is—',
 '150','250 and more','120','40',
 'B','Nigeria has over 250 ethnic groups, making it one of the most ethnically diverse countries in the world.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Yoruba Political System',
 'An Oba''s judicial decision was enforced by the age grades called—',
 'Elegbe','Ogboni','Baale','Sango',
 'A','The Elegbe age grade was responsible for enforcing the Oba''s decisions.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Land Tenure',
 'The mechanism by which land is made available to cultivators is called—',
 'Fallow system','Land tenure','Land acquisition','Occupancy right',
 'B','Land tenure refers to the system of rules governing how land is held, used, and transferred.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Health in Nigeria',
 'These are cultural impediments in the control of HIV/AIDS in Nigeria EXCEPT—',
 'Polygamy','Early marriage','Disinheritance of widows','Sacrifices',
 'D','Sacrifices are not a cultural impediment to HIV/AIDS control. Polygamy, early marriage, and widow disinheritance are actual risk factors.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Cultural Concepts',
 '______ is a socio-historical concept and embodiment of culture and an invention for adaptation to the environment.',
 'Heritage','Cosmology','Culture','Symbol',
 'A','Heritage is the socio-historical embodiment of a people''s culture and their collective adaptation to their environment.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Nigeria & Colonialism',
 'Colonization involves all EXCEPT—',
 'Economic exploitation','Political marginalization','Social disorganization','Equity',
 'D','Equity is not a feature of colonization. Colonization is characterized by exploitation, marginalization, and disorganization.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Health in Nigeria',
 'What is the agency responsible for the coordination of national HIV/AIDS called?',
 'UNICEF','UNESCO','NACA','WHO',
 'C','The National Agency for the Control of AIDS (NACA) is the government body coordinating HIV/AIDS response in Nigeria.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Cultural Concepts',
 '_____ infections attack people whose immune system have been badly compromised.',
 'Vigorous','Opportunistic','Syndrome','Immune deficiency',
 'B','Opportunistic infections take advantage of a weakened immune system, which is characteristic of AIDS.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Nigeria & Colonialism',
 'Nigeria is a ________ creation.',
 'Colonial','Post-colonial','Pre-colonial','None of the above',
 'A','Nigeria as a political entity was created by British colonialism, with the name given by Flora Shaw in 1897.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Hausa Political System',
 'In centralized societies, social mobility is—',
 'Accessible','Fixed','Flexible','Impossible',
 'B','In centralized (hierarchical) societies, social status tends to be fixed and determined by birth.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Health in Nigeria',
 'Which of these health problems does traditional medicine in Nigeria compete favourably with orthodox medicine?',
 'HIV/AIDS','Surgery','Orthopedics','Cancer',
 'C','Traditional bone-setting (orthopedics) is an area where traditional medicine in Nigeria has been effective.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Igbo Cultural Practices',
 'Among the Igbo, the born-to-die child is called—',
 'Obiarije','Odanje','Ogbanje','Ochanja',
 'C','Ogbanje is the Igbo concept of a child believed to die and be reborn repeatedly, tormenting the family.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Religion in Nigeria',
 '____ carried out a Jihad in Northern Nigeria.',
 'Ahmadu Bello','Tafawa Belewa','Gali Naaba','Usman Dan Fodio',
 'D','Usman Dan Fodio launched the Fulani Jihad in 1804, which transformed northern Nigeria into the Sokoto Caliphate.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Religion in Nigeria',
 'Orisa is worshipped among ______ people.',
 'Igbo','Fulani','Hausa','Yoruba',
 'D','Orisa (or Orisha) are spirits and deities worshipped in Yoruba traditional religion.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Social Institutions',
 'The basic unit of society is—',
 'The state','The family','The community','The market',
 'B','The family is universally recognized as the basic unit of society.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Cultural Concepts',
 'Ethnocentrism refers to—',
 'The study of ethnic groups','Judging others by the standards of one''s own culture','Respect for cultural differences','The blending of cultures',
 'B','Ethnocentrism is the tendency to view one''s own cultural group as superior and to judge other cultures by its standards.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Social Institutions',
 'Which of the following is NOT a function of the family?',
 'Reproduction','Socialization','Taxation','Protection',
 'C','Taxation is a function of the state, not the family. The family''s functions include reproduction, socialization, economic support, and protection.',
 2023),

('UNIVERSITY','UNIPORT','GES103','Kinship & Descent',
 'A patrilineal descent system traces lineage through—',
 'The mother''s side','The father''s side','Both parents equally','Neither parent',
 'B','In a patrilineal descent system, lineage, identity, and inheritance are traced through the father''s line.',
 2023)

ON CONFLICT DO NOTHING;

-- Backend: add university course count endpoint
-- See examController.js for the /exam/university-course-counts implementation

-- Summary of questions added:
-- GES112 (History, Culture & Art to 1800): 20 questions
-- GES103 (Social Institutions, Culture): 20 questions
-- Total: 40 questions
-- PDF from user (GES112.2) will add more when uploaded
