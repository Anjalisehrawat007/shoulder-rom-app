/**
 * tutorial.js — language picker + spoken step-by-step walkthrough.
 *
 * There's no recorded video here: this app can't produce narrated video
 * content. Instead each step is narrated live using the browser's built-in
 * text-to-speech engine (Web Speech API) in the selected language, with the
 * same text shown as an on-screen caption. Voice availability depends on
 * the visitor's device/OS — if no matching voice is found, narration is
 * skipped and the captions still walk the patient through the app silently.
 *
 * Translations below are machine-generated and have NOT been reviewed by a
 * native speaker per language. Have a native speaker check them (especially
 * Odia and Assamese, where confidence is lower) before relying on this for
 * real patients.
 */
const LANGUAGES = [
  { code: "en", flag: "🇬🇧", native: "English", bcp47: "en-US" },
  { code: "hi", flag: "🇮🇳", native: "हिन्दी", romanized: "Hindi", bcp47: "hi-IN" },
  { code: "bn-BD", flag: "🇧🇩", native: "বাংলা", romanized: "Bangladesh", bcp47: "bn-BD" },
  { code: "bn-IN", flag: "🇮🇳", native: "বাংলা", romanized: "India", bcp47: "bn-IN" },
  { code: "ta", flag: "🇮🇳", native: "தமிழ்", romanized: "Tamil", bcp47: "ta-IN" },
  { code: "te", flag: "🇮🇳", native: "తెలుగు", romanized: "Telugu", bcp47: "te-IN" },
  { code: "kn", flag: "🇮🇳", native: "ಕನ್ನಡ", romanized: "Kannada", bcp47: "kn-IN" },
  { code: "ml", flag: "🇮🇳", native: "മലയാളം", romanized: "Malayalam", bcp47: "ml-IN" },
  { code: "mr", flag: "🇮🇳", native: "मराठी", romanized: "Marathi", bcp47: "mr-IN" },
  { code: "gu", flag: "🇮🇳", native: "ગુજરાતી", romanized: "Gujarati", bcp47: "gu-IN" },
  { code: "pa", flag: "🇮🇳", native: "ਪੰਜਾਬੀ", romanized: "Punjabi", bcp47: "pa-IN" },
  { code: "or", flag: "🇮🇳", native: "ଓଡ଼ିଆ", romanized: "Odia", bcp47: "or-IN" },
  { code: "as", flag: "🇮🇳", native: "অসমীয়া", romanized: "Assamese", bcp47: "as-IN" },
  { code: "ur", flag: "🇵🇰", native: "اردو", romanized: "Urdu", bcp47: "ur-PK", rtl: true },
  { code: "ne", flag: "🇳🇵", native: "नेपाली", romanized: "Nepali", bcp47: "ne-NP" },
  { code: "si", flag: "🇱🇰", native: "සිංහල", romanized: "Sinhala", bcp47: "si-LK" },
];

const STEPS = [
  {
    icon: "👋",
    text: {
      en: "Welcome! This app helps track your shoulder movement using your phone's camera.",
      hi: "स्वागत है! यह ऐप आपके फ़ोन के कैमरे का उपयोग करके आपके कंधे की गति को ट्रैक करने में मदद करता है।",
      "bn-BD": "স্বাগতম! এই অ্যাপটি আপনার ফোনের ক্যামেরা ব্যবহার করে আপনার কাঁধের নড়াচড়া ট্র্যাক করতে সাহায্য করে।",
      "bn-IN": "স্বাগতম! এই অ্যাপটি আপনার ফোনের ক্যামেরা ব্যবহার করে আপনার কাঁধের নড়াচড়া ট্র্যাক করতে সাহায্য করে।",
      ta: "வரவேற்கிறோம்! இந்த ஆப் உங்கள் ஃபோன் கேமராவைப் பயன்படுத்தி உங்கள் தோள்பட்டை அசைவை கண்காணிக்க உதவுகிறது.",
      te: "స్వాగతం! ఈ యాప్ మీ ఫోన్ కెమెరాను ఉపయోగించి మీ భుజం కదలికను ట్రాక్ చేయడంలో సహాయపడుతుంది.",
      kn: "ಸ್ವಾಗತ! ಈ ಆ್ಯಪ್ ನಿಮ್ಮ ಫೋನ್ ಕ್ಯಾಮೆರಾ ಬಳಸಿ ನಿಮ್ಮ ಭುಜದ ಚಲನೆಯನ್ನು ಟ್ರ್ಯಾಕ್ ಮಾಡಲು ಸಹಾಯ ಮಾಡುತ್ತದೆ.",
      ml: "സ്വാഗതം! നിങ്ങളുടെ ഫോൺ ക്യാമറ ഉപയോഗിച്ച് നിങ്ങളുടെ തോളിന്റെ ചലനം ട്രാക്ക് ചെയ്യാൻ ഈ ആപ്പ് സഹായിക്കുന്നു.",
      mr: "स्वागत आहे! हे अ‍ॅप तुमच्या फोनच्या कॅमेराचा वापर करून तुमच्या खांद्याच्या हालचालीचा मागोवा घेण्यास मदत करते.",
      gu: "સ્વાગત છે! આ એપ તમારા ફોનના કેમેરાનો ઉપયોગ કરીને તમારા ખભાની હિલચાલને ટ્રેક કરવામાં મદદ કરે છે.",
      pa: "ਜੀ ਆਇਆਂ ਨੂੰ! ਇਹ ਐਪ ਤੁਹਾਡੇ ਫ਼ੋਨ ਦੇ ਕੈਮਰੇ ਦੀ ਵਰਤੋਂ ਕਰਕੇ ਤੁਹਾਡੇ ਮੋਢੇ ਦੀ ਹਰਕਤ ਨੂੰ ਟਰੈਕ ਕਰਨ ਵਿੱਚ ਮਦਦ ਕਰਦੀ ਹੈ।",
      or: "ସ୍ୱାଗତ! ଏହି ଆପ୍ ଆପଣଙ୍କ ଫୋନ୍ କ୍ୟାମେରା ବ୍ୟବହାର କରି ଆପଣଙ୍କ କାନ୍ଧର ଗତିବିଧି ଟ୍ରାକ୍ କରିବାରେ ସାହାଯ୍ୟ କରେ।",
      as: "স্বাগতম! এই এপ্‌টোৱে আপোনাৰ ফ'নৰ কেমেৰা ব্যৱহাৰ কৰি আপোনাৰ কান্ধৰ গতিবিধি ট্ৰেক কৰাত সহায় কৰে।",
      ur: "خوش آمدید! یہ ایپ آپ کے فون کے کیمرے کا استعمال کرتے ہوئے آپ کے کندھے کی حرکت کو ٹریک کرنے میں مدد کرتی ہے۔",
      ne: "स्वागत छ! यो एपले तपाईंको फोनको क्यामेरा प्रयोग गरेर तपाईंको काँधको चाललाई ट्र्याक गर्न मद्दत गर्छ।",
      si: "ආයුබෝවන්! මෙම යෙදුම ඔබේ දුරකථන කැමරාව භාවිතයෙන් ඔබේ උරහිසේ චලනය නිරීක්ෂණය කිරීමට උපකාරී වේ.",
    },
  },
  {
    icon: "🆔",
    text: {
      en: "First, enter the 7-digit hospital ID given to you at your appointment.",
      hi: "सबसे पहले, अपने अपॉइंटमेंट पर दिया गया 7 अंकों का हॉस्पिटल आईडी दर्ज करें।",
      "bn-BD": "প্রথমে, আপনার অ্যাপয়েন্টমেন্টে দেওয়া ৭-সংখ্যার হাসপাতাল আইডি লিখুন।",
      "bn-IN": "প্রথমে, আপনার অ্যাপয়েন্টমেন্টে দেওয়া ৭-সংখ্যার হাসপাতাল আইডি লিখুন।",
      ta: "முதலில், உங்கள் அப்பாயிண்ட்மென்ட்டில் தரப்பட்ட 7 இலக்க மருத்துவமனை ஐடியை உள்ளிடவும்.",
      te: "మొదట, మీ అపాయింట్‌మెంట్‌లో ఇచ్చిన 7 అంకెల హాస్పిటల్ ఐడీని నమోదు చేయండి.",
      kn: "ಮೊದಲು, ನಿಮ್ಮ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್‌ನಲ್ಲಿ ನೀಡಲಾದ 7 ಅಂಕಿಗಳ ಆಸ್ಪತ್ರೆ ಐಡಿಯನ್ನು ನಮೂದಿಸಿ.",
      ml: "ആദ്യം, നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റിൽ നൽകിയ 7 അക്ക ഹോസ്പിറ്റൽ ഐഡി നൽകുക.",
      mr: "प्रथम, तुमच्या अपॉइंटमेंटमध्ये दिलेला 7 अंकी हॉस्पिटल आयडी टाका.",
      gu: "પહેલા, તમારી અપોઈન્ટમેન્ટમાં આપવામાં આવેલ 7-અંકનો હોસ્પિટલ આઈડી દાખલ કરો.",
      pa: "ਪਹਿਲਾਂ, ਆਪਣੀ ਅਪੌਇੰਟਮੈਂਟ ਵਿੱਚ ਦਿੱਤਾ ਗਿਆ 7-ਅੰਕਾਂ ਵਾਲਾ ਹਸਪਤਾਲ ਆਈਡੀ ਦਰਜ ਕਰੋ।",
      or: "ପ୍ରଥମେ, ଆପଣଙ୍କ ଅପଏଣ୍ଟମେଣ୍ଟରେ ଦିଆଯାଇଥିବା 7-ଅଙ୍କ ବିଶିଷ୍ଟ ହସ୍ପିଟାଲ ID ପ୍ରବେଶ କରନ୍ତୁ।",
      as: "প্ৰথমে, আপোনাৰ এপইনমেণ্টত দিয়া 7-অংকৰ হাস্পাতাল আইডি প্ৰবিষ্ট কৰক।",
      ur: "پہلے، اپنی اپائنٹمنٹ پر دیا گیا 7 ہندسوں کا ہسپتال آئی ڈی درج کریں۔",
      ne: "पहिले, तपाईंको अपोइन्टमेन्टमा दिइएको 7-अंकको अस्पताल आईडी प्रविष्ट गर्नुहोस्।",
      si: "පළමුව, ඔබේ හමුවේදී ලබා දුන් අංක 7ක රෝහල් හැඳුනුම්පත ඇතුළත් කරන්න.",
    },
  },
  {
    icon: "🤳",
    text: {
      en: "Choose which arm is being tested, then tap 'Begin session'.",
      hi: "किस बांह की जांच की जा रही है यह चुनें, फिर 'सेशन शुरू करें' पर टैप करें।",
      "bn-BD": "কোন হাত পরীক্ষা করা হচ্ছে তা বেছে নিন, তারপর 'সেশন শুরু করুন'-এ ট্যাপ করুন।",
      "bn-IN": "কোন হাত পরীক্ষা করা হচ্ছে তা বেছে নিন, তারপর 'সেশন শুরু করুন'-এ ট্যাপ করুন।",
      ta: "எந்தக் கை பரிசோதிக்கப்படுகிறது என்பதைத் தேர்ந்தெடுத்து, பின்னர் 'செஷனைத் தொடங்கு' என்பதைத் தட்டவும்.",
      te: "ఏ చేయి పరీక్షించబడుతుందో ఎంచుకోండి, తర్వాత 'సెషన్ ప్రారంభించు' నొక్కండి.",
      kn: "ಯಾವ ತೋಳನ್ನು ಪರೀಕ್ಷಿಸಲಾಗುತ್ತಿದೆ ಎಂದು ಆಯ್ಕೆಮಾಡಿ, ನಂತರ 'ಸೆಷನ್ ಪ್ರಾರಂಭಿಸಿ' ಒತ್ತಿರಿ.",
      ml: "ഏത് കൈയാണ് പരിശോധിക്കുന്നതെന്ന് തിരഞ്ഞെടുക്കുക, തുടർന്ന് 'സെഷൻ ആരംഭിക്കുക' ടാപ്പ് ചെയ്യുക.",
      mr: "कोणता हात तपासला जात आहे ते निवडा, नंतर 'सेशन सुरू करा' वर टॅप करा.",
      gu: "કયો હાથ ચકાસવામાં આવી રહ્યો છે તે પસંદ કરો, પછી 'સેશન શરૂ કરો' પર ટેપ કરો.",
      pa: "ਕਿਹੜੀ ਬਾਂਹ ਦੀ ਜਾਂਚ ਕੀਤੀ ਜਾ ਰਹੀ ਹੈ ਚੁਣੋ, ਫਿਰ 'ਸੈਸ਼ਨ ਸ਼ੁਰੂ ਕਰੋ' 'ਤੇ ਟੈਪ ਕਰੋ।",
      or: "କେଉଁ ହାତ ପରୀକ୍ଷା କରାଯାଉଛି ବାଛନ୍ତୁ, ତାପରେ 'ସେସନ୍ ଆରମ୍ଭ କରନ୍ତୁ' ଟାପ୍ କରନ୍ତୁ।",
      as: "কোনটো হাত পৰীক্ষা কৰা হৈছে বাছনি কৰক, তাৰ পিছত 'ছেছন আৰম্ভ কৰক'ত টেপ কৰক।",
      ur: "منتخب کریں کہ کون سا بازو ٹیسٹ کیا جا رہا ہے، پھر 'سیشن شروع کریں' پر ٹیپ کریں۔",
      ne: "कुन पाखुरा जाँच गरिँदैछ छान्नुहोस्, त्यसपछि 'सत्र सुरु गर्नुहोस्' मा ट्याप गर्नुहोस्।",
      si: "පරීක්ෂා කරන්නේ කුමන අතද යන්න තෝරන්න, පසුව 'සැසිය ආරම්භ කරන්න' ටැප් කරන්න.",
    },
  },
  {
    icon: "🔑",
    text: {
      en: "A code will appear on screen — a staff member will help note it down.",
      hi: "स्क्रीन पर एक कोड दिखाई देगा — स्टाफ सदस्य इसे नोट करने में मदद करेंगे।",
      "bn-BD": "স্ক্রিনে একটি কোড দেখা যাবে — একজন কর্মী এটি লিখে রাখতে সাহায্য করবেন।",
      "bn-IN": "স্ক্রিনে একটি কোড দেখা যাবে — একজন কর্মী এটি লিখে রাখতে সাহায্য করবেন।",
      ta: "திரையில் ஒரு குறியீடு தோன்றும் — அதை பணியாளர் குறித்துக்கொள்ள உதவுவார்.",
      te: "స్క్రీన్‌పై ఒక కోడ్ కనిపిస్తుంది — దానిని సిబ్బంది గమనించడంలో సహాయపడతారు.",
      kn: "ಪರದೆಯ ಮೇಲೆ ಒಂದು ಕೋಡ್ ಕಾಣಿಸುತ್ತದೆ — ಸಿಬ್ಬಂದಿ ಸದಸ್ಯರು ಅದನ್ನು ಬರೆದುಕೊಳ್ಳಲು ಸಹಾಯ ಮಾಡುತ್ತಾರೆ.",
      ml: "സ്ക്രീനിൽ ഒരു കോഡ് ദൃശ്യമാകും — ഒരു സ്റ്റാഫ് അംഗം അത് കുറിച്ചെടുക്കാൻ സഹായിക്കും.",
      mr: "स्क्रीनवर एक कोड दिसेल — एक कर्मचारी तो नोंदवण्यास मदत करेल.",
      gu: "સ્ક્રીન પર એક કોડ દેખાશે — સ્ટાફ સભ્ય તેને નોંધવામાં મદદ કરશે.",
      pa: "ਸਕ੍ਰੀਨ 'ਤੇ ਇੱਕ ਕੋਡ ਦਿਖਾਈ ਦੇਵੇਗਾ — ਇੱਕ ਸਟਾਫ਼ ਮੈਂਬਰ ਇਸਨੂੰ ਨੋਟ ਕਰਨ ਵਿੱਚ ਮਦਦ ਕਰੇਗਾ।",
      or: "ସ୍କ୍ରିନ୍ ରେ ଏକ କୋଡ୍ ଦେଖାଯିବ — ଜଣେ କର୍ମଚାରୀ ଏହାକୁ ଲେଖିରଖିବାରେ ସାହାଯ୍ୟ କରିବେ।",
      as: "স্ক্ৰীণত এটা ক'ড দেখা যাব — এজন ষ্টাফে ইয়াক লিখি ৰাখিবলৈ সহায় কৰিব।",
      ur: "اسکرین پر ایک کوڈ ظاہر ہوگا — عملے کا رکن اسے نوٹ کرنے میں مدد کرے گا۔",
      ne: "स्क्रिनमा एउटा कोड देखा पर्नेछ — कर्मचारीले यो नोट गर्न मद्दत गर्नेछन्।",
      si: "තිරය මත කේතයක් දිස්වනු ඇත — කාර්ය මණ්ඩල සාමාජිකයෙකු එය සටහන් කර ගැනීමට උදව් කරනු ඇත.",
    },
  },
  {
    icon: "📷",
    text: {
      en: "Allow camera access, then position yourself so your upper body is fully visible.",
      hi: "कैमरे की अनुमति दें, फिर खुद को इस तरह रखें कि आपका ऊपरी शरीर पूरी तरह दिखे।",
      "bn-BD": "ক্যামেরা অ্যাক্সেসের অনুমতি দিন, তারপর নিজেকে এমনভাবে রাখুন যাতে আপনার শরীরের উপরের অংশ পুরোপুরি দেখা যায়।",
      "bn-IN": "ক্যামেরা অ্যাক্সেসের অনুমতি দিন, তারপর নিজেকে এমনভাবে রাখুন যাতে আপনার শরীরের উপরের অংশ পুরোপুরি দেখা যায়।",
      ta: "கேமரா அணுகலை அனுமதிக்கவும், பின்னர் உங்கள் மேல்உடல் முழுவதும் தெரியும்படி நிற்கவும்.",
      te: "కెమెరా యాక్సెస్‌ను అనుమతించండి, తర్వాత మీ శరీరం పై భాగం పూర్తిగా కనిపించేలా నిలబడండి.",
      kn: "ಕ್ಯಾಮೆರಾ ಪ್ರವೇಶವನ್ನು ಅನುಮತಿಸಿ, ನಂತರ ನಿಮ್ಮ ಮೇಲ್ಭಾಗದ ದೇಹ ಸಂಪೂರ್ಣವಾಗಿ ಕಾಣುವಂತೆ ನಿಲ್ಲಿರಿ.",
      ml: "ക്യാമറ ആക്സസ് അനുവദിക്കുക, തുടർന്ന് നിങ്ങളുടെ ശരീരത്തിന്റെ മുകൾഭാഗം പൂർണ്ണമായി കാണുന്ന വിധം നിൽക്കുക.",
      mr: "कॅमेरा अ‍ॅक्सेसला परवानगी द्या, नंतर तुमचा वरचा शरीरभाग पूर्णपणे दिसेल असे उभे रहा.",
      gu: "કેમેરા ઍક્સેસની મંજૂરી આપો, પછી તમારી જાતને એ રીતે ગોઠવો કે તમારું ઉપરનું શરીર સંપૂર્ણ દેખાય.",
      pa: "ਕੈਮਰਾ ਪਹੁੰਚ ਦੀ ਇਜਾਜ਼ਤ ਦਿਓ, ਫਿਰ ਆਪਣੇ ਆਪ ਨੂੰ ਇਸ ਤਰ੍ਹਾਂ ਰੱਖੋ ਕਿ ਤੁਹਾਡਾ ਉੱਪਰਲਾ ਸਰੀਰ ਪੂਰੀ ਤਰ੍ਹਾਂ ਦਿਖਾਈ ਦੇਵੇ।",
      or: "କ୍ୟାମେରା ପ୍ରବେଶାଧିକାର ଅନୁମତି ଦିଅନ୍ତୁ, ତାପରେ ନିଜକୁ ଏମିତି ରଖନ୍ତୁ ଯେପରି ଆପଣଙ୍କ ଶରୀରର ଉପର ଭାଗ ସମ୍ପୂର୍ଣ୍ଣ ଦେଖାଯାଏ।",
      as: "কেমেৰা এক্সেছৰ অনুমতি দিয়ক, তাৰ পিছত নিজকে এনেদৰে ৰাখক যাতে আপোনাৰ ওপৰৰ শৰীৰ সম্পূৰ্ণৰূপে দেখা যায়।",
      ur: "کیمرے کی رسائی کی اجازت دیں، پھر خود کو اس طرح رکھیں کہ آپ کا اوپری جسم مکمل طور پر نظر آئے۔",
      ne: "क्यामेरा पहुँचको अनुमति दिनुहोस्, त्यसपछि आफूलाई यसरी राख्नुहोस् कि तपाईंको माथिल्लो शरीर पूर्ण रूपमा देखियोस्।",
      si: "කැමරා ප්‍රවේශයට අවසර දෙන්න, පසුව ඔබේ ශරීරයේ ඉහළ කොටස සම්පූර්ණයෙන් පෙනෙන පරිදි සිටගන්න.",
    },
  },
  {
    icon: "🙆",
    text: {
      en: "You'll be asked to do 4 simple movements — touch your head, touch your mouth, comb your hair, and lift your arm sideways. Hold each position steady for a few seconds.",
      hi: "आपसे 4 सरल हरकतें करने को कहा जाएगा — सिर छूना, मुंह छूना, बाल में कंघी करना, और बांह को बगल में ऊपर उठाना। हर स्थिति को कुछ सेकंड तक स्थिर रखें।",
      "bn-BD": "আপনাকে ৪টি সহজ নড়াচড়া করতে বলা হবে — মাথা স্পর্শ করা, মুখ স্পর্শ করা, চুল আঁচড়ানো, এবং হাত পাশে তোলা। প্রতিটি অবস্থান কয়েক সেকেন্ড স্থির রাখুন।",
      "bn-IN": "আপনাকে ৪টি সহজ নড়াচড়া করতে বলা হবে — মাথা স্পর্শ করা, মুখ স্পর্শ করা, চুল আঁচড়ানো, এবং হাত পাশে তোলা। প্রতিটি অবস্থান কয়েক সেকেন্ড স্থির রাখুন।",
      ta: "உங்களிடம் 4 எளிய அசைவுகள் செய்யச் சொல்லப்படும் — தலையைத் தொடுதல், வாயைத் தொடுதல், முடி வாருதல், மற்றும் கையை பக்கவாட்டில் உயர்த்துதல். ஒவ்வொரு நிலையையும் சில வினாடிகள் நிலையாக வைத்திருங்கள்.",
      te: "మిమ్మల్ని 4 సాధారణ కదలికలు చేయమని అడుగుతారు — తలను తాకడం, నోటిని తాకడం, జుట్టు దువ్వడం, మరియు చేయిని పక్కకు పైకి లేపడం. ప్రతి భంగిమను కొన్ని సెకన్ల పాటు స్థిరంగా ఉంచండి.",
      kn: "ನಿಮಗೆ 4 ಸರಳ ಚಲನೆಗಳನ್ನು ಮಾಡಲು ಕೇಳಲಾಗುತ್ತದೆ — ತಲೆ ಮುಟ್ಟುವುದು, ಬಾಯಿ ಮುಟ್ಟುವುದು, ಕೂದಲು ಬಾಚುವುದು, ಮತ್ತು ತೋಳನ್ನು ಪಕ್ಕಕ್ಕೆ ಮೇಲಕ್ಕೆತ್ತುವುದು. ಪ್ರತಿ ಭಂಗಿಯನ್ನು ಕೆಲವು ಸೆಕೆಂಡುಗಳ ಕಾಲ ಸ್ಥಿರವಾಗಿ ಹಿಡಿದುಕೊಳ್ಳಿ.",
      ml: "നിങ്ങളോട് 4 ലളിതമായ ചലനങ്ങൾ ചെയ്യാൻ ആവശ്യപ്പെടും — തല സ്പർശിക്കുക, വായ സ്പർശിക്കുക, മുടി ചീകുക, കൈ വശത്തേക്ക് ഉയർത്തുക. ഓരോ നിലയും കുറച്ച് സെക്കൻഡ് സ്ഥിരമായി പിടിക്കുക.",
      mr: "तुम्हाला 4 सोप्या हालचाली करण्यास सांगितले जाईल — डोक्याला स्पर्श करणे, तोंडाला स्पर्श करणे, केस विंचरणे, आणि हात बाजूला वर उचलणे. प्रत्येक स्थिती काही सेकंद स्थिर ठेवा.",
      gu: "તમને 4 સરળ હલનચલન કરવાનું કહેવામાં આવશે — માથાને સ્પર્શ કરવો, મોંને સ્પર્શ કરવો, વાળ ઓળવા, અને હાથને બાજુમાં ઊંચો કરવો. દરેક સ્થિતિ થોડી સેકંડ સ્થિર રાખો.",
      pa: "ਤੁਹਾਨੂੰ 4 ਸਧਾਰਨ ਹਰਕਤਾਂ ਕਰਨ ਲਈ ਕਿਹਾ ਜਾਵੇਗਾ — ਸਿਰ ਨੂੰ ਛੂਹਣਾ, ਮੂੰਹ ਨੂੰ ਛੂਹਣਾ, ਵਾਲਾਂ ਵਿੱਚ ਕੰਘੀ ਕਰਨਾ, ਅਤੇ ਬਾਂਹ ਨੂੰ ਪਾਸੇ ਵੱਲ ਉੱਪਰ ਚੁੱਕਣਾ। ਹਰੇਕ ਸਥਿਤੀ ਨੂੰ ਕੁਝ ਸਕਿੰਟਾਂ ਲਈ ਸਥਿਰ ਰੱਖੋ।",
      or: "ଆପଣଙ୍କୁ 4ଟି ସରଳ ଗତିବିଧି କରିବାକୁ କୁହାଯିବ — ମୁଣ୍ଡ ଛୁଇଁବା, ମୁହଁ ଛୁଇଁବା, ବାଳ ବିନ୍ଧିବା, ଏବଂ ହାତକୁ ପାର୍ଶ୍ୱକୁ ଉପରକୁ ଉଠାଇବା। ପ୍ରତ୍ୟେକ ସ୍ଥିତିକୁ କିଛି ସେକେଣ୍ଡ ସ୍ଥିର ରଖନ୍ତୁ।",
      as: "আপোনাক 4টা সহজ গতিবিধি কৰিবলৈ কোৱা হ'ব — মূৰ চুবলা, মুখ চুবলা, চুলি আঁচোৰা, আৰু হাত কাষলৈ ওপৰলৈ তোলা। প্ৰতিটো অৱস্থা কেইছেকেণ্ডমান স্থিৰ কৰি ৰাখক।",
      ur: "آپ سے 4 آسان حرکتیں کرنے کو کہا جائے گا — سر کو چھونا، منہ کو چھونا، بال میں کنگھی کرنا، اور بازو کو سائیڈ سے اوپر اٹھانا۔ ہر پوزیشن کو چند سیکنڈ کے لیے ساکت رکھیں۔",
      ne: "तपाईंलाई 4 सरल चालहरू गर्न भनिनेछ — टाउको छुनु, मुख छुनु, कपाल कोर्नु, र पाखुरा छेउतिर माथि उठाउनु। प्रत्येक अवस्था केही सेकेन्ड स्थिर राख्नुहोस्।",
      si: "ඔබෙන් සරල චලන 4ක් කිරීමට ඉල්ලා සිටිනු ඇත — හිස ස්පර්ශ කිරීම, මුඛය ස්පර්ශ කිරීම, කොණ්ඩය පීරීම, සහ අත පැත්තට ඔසවා තැබීම. සෑම ඉරියව්වක්ම තත්පර කිහිපයක් ස්ථිරව තබා ගන්න.",
    },
  },
  {
    icon: "✅",
    text: {
      en: "That's it! Once all 4 movements are done, your session is complete. Your doctor will review the results.",
      hi: "बस इतना ही! सभी 4 हरकतें पूरी होने पर आपका सेशन पूरा हो जाएगा। आपका डॉक्टर परिणामों की समीक्षा करेगा।",
      "bn-BD": "ব্যাস! ৪টি নড়াচড়া শেষ হলে আপনার সেশন সম্পূর্ণ হবে। আপনার ডাক্তার ফলাফল পর্যালোচনা করবেন।",
      "bn-IN": "ব্যাস! ৪টি নড়াচড়া শেষ হলে আপনার সেশন সম্পূর্ণ হবে। আপনার ডাক্তার ফলাফল পর্যালোচনা করবেন।",
      ta: "அவ்வளவுதான்! 4 அசைவுகளும் முடிந்ததும் உங்கள் செஷன் முடிந்துவிடும். உங்கள் மருத்துவர் முடிவுகளை மதிப்பாய்வு செய்வார்.",
      te: "అంతే! 4 కదలికలు పూర్తయిన తర్వాత మీ సెషన్ పూర్తవుతుంది. మీ డాక్టర్ ఫలితాలను సమీక్షిస్తారు.",
      kn: "ಅಷ್ಟೇ! ಎಲ್ಲಾ 4 ಚಲನೆಗಳು ಮುಗಿದ ನಂತರ ನಿಮ್ಮ ಸೆಷನ್ ಪೂರ್ಣಗೊಳ್ಳುತ್ತದೆ. ನಿಮ್ಮ ವೈದ್ಯರು ಫಲಿತಾಂಶಗಳನ್ನು ಪರಿಶೀಲಿಸುತ್ತಾರೆ.",
      ml: "ഇത്രമാത്രം! 4 ചലനങ്ങളും പൂർത്തിയായാൽ നിങ്ങളുടെ സെഷൻ പൂർത്തിയാകും. നിങ്ങളുടെ ഡോക്ടർ ഫലങ്ങൾ പരിശോധിക്കും.",
      mr: "इतकंच! सर्व 4 हालचाली पूर्ण झाल्यावर तुमचे सेशन पूर्ण होईल. तुमचे डॉक्टर निकालांचे पुनरावलोकन करतील.",
      gu: "બસ આટલું જ! બધી 4 હલનચલન પૂર્ણ થયા પછી તમારું સેશન પૂર્ણ થશે. તમારા ડૉક્ટર પરિણામોની સમીક્ષા કરશે.",
      pa: "ਬੱਸ ਇੰਨਾ ਹੀ! ਸਾਰੀਆਂ 4 ਹਰਕਤਾਂ ਪੂਰੀਆਂ ਹੋਣ 'ਤੇ ਤੁਹਾਡਾ ਸੈਸ਼ਨ ਪੂਰਾ ਹੋ ਜਾਵੇਗਾ। ਤੁਹਾਡਾ ਡਾਕਟਰ ਨਤੀਜਿਆਂ ਦੀ ਸਮੀਖਿਆ ਕਰੇਗਾ।",
      or: "ବସ୍ ଏତିକି! ସମସ୍ତ 4ଟି ଗତିବିଧି ସମାପ୍ତ ହେଲେ ଆପଣଙ୍କ ସେସନ୍ ସମ୍ପୂର୍ଣ୍ଣ ହେବ। ଆପଣଙ୍କ ଡାକ୍ତର ଫଳାଫଳ ସମୀକ୍ଷା କରିବେ।",
      as: "ব্যাছ! সকলো 4টা গতিবিধি সম্পূৰ্ণ হ'লে আপোনাৰ ছেছন সম্পূৰ্ণ হ'ব। আপোনাৰ চিকিৎসকে ফলাফল পৰ্যালোচনা কৰিব।",
      ur: "بس اتنا ہی! چاروں حرکتیں مکمل ہونے پر آپ کا سیشن مکمل ہو جائے گا۔ آپ کا ڈاکٹر نتائج کا جائزہ لے گا۔",
      ne: "बस्! सबै 4 चालहरू पूरा भएपछि तपाईंको सत्र पूरा हुनेछ। तपाईंको डाक्टरले नतिजाहरू समीक्षा गर्नेछन्।",
      si: "එපමණයි! චලන 4ම අවසන් වූ පසු ඔබේ සැසිය සම්පූර්ණ වේ. ඔබේ වෛද්‍යවරයා ප්‍රතිඵල සමාලෝචනය කරනු ඇත.",
    },
  },
];

let currentLang = null;
let currentStep = 0;

function renderLangGrid() {
  const grid = document.getElementById("langGrid");
  grid.innerHTML = LANGUAGES.map((l) => `
    <button class="btn lang-btn panel" data-code="${l.code}">
      <span class="flag">${l.flag}</span>
      <span dir="${l.rtl ? "rtl" : "ltr"}">
        <span class="native">${l.native}</span>
        ${l.romanized ? `<span class="romanized">${l.romanized}</span>` : ""}
      </span>
      <span class="voice-badge" data-badge="${l.code}" title="Checking voice availability…">…</span>
    </button>
  `).join("");
  grid.querySelectorAll(".lang-btn").forEach((btn) => {
    btn.addEventListener("click", () => startWalkthrough(btn.dataset.code));
  });
  refreshVoiceBadges();
}

async function refreshVoiceBadges() {
  await ensureVoicesLoaded();
  for (const l of LANGUAGES) {
    const badge = document.querySelector(`[data-badge="${l.code}"]`);
    if (!badge) continue;
    const available = candidateVoices(l.bcp47).length > 0;
    badge.textContent = available ? "🔊" : "🔇";
    badge.title = available
      ? "Spoken narration available on this device"
      : "No voice installed for this language on this device — captions only";
  }
}

// Default OS-bundled TTS voices (e.g. "eSpeak" on Linux, compact SAPI voices
// on Windows) are often flat and hard to understand. Cloud/neural voices —
// Chrome's "Google …" voices, Edge's "… Online (Natural)" voices — sound far
// clearer, so we rank candidates and prefer those when more than one exists.
function voiceQualityScore(v) {
  const name = v.name.toLowerCase();
  if (name.includes("natural") || name.includes("online") || name.includes("neural")) return 3;
  if (name.includes("google")) return 2;
  if (!v.localService) return 1;
  return 0;
}

function candidateVoices(bcp47) {
  if (!("speechSynthesis" in window)) return [];
  const voices = window.speechSynthesis.getVoices();
  const base = bcp47.split("-")[0].toLowerCase();
  const exact = voices.filter((v) => v.lang.toLowerCase() === bcp47.toLowerCase());
  const partial = voices.filter((v) => v.lang.toLowerCase().startsWith(base) && !exact.includes(v));
  return [...exact, ...partial].sort((a, b) => voiceQualityScore(b) - voiceQualityScore(a));
}

const voiceIndexByLang = {};

function ensureVoicesLoaded() {
  if (!("speechSynthesis" in window)) return Promise.resolve();
  if (window.speechSynthesis.getVoices().length > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    window.speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 400); // fallback if the event never fires
  });
}

function speak(text, bcp47) {
  if (!("speechSynthesis" in window)) return { spoke: false };
  window.speechSynthesis.cancel();
  const candidates = candidateVoices(bcp47);
  if (candidates.length === 0) return { spoke: false, voiceCount: 0 };
  const idx = (voiceIndexByLang[bcp47] || 0) % candidates.length;
  const voice = candidates[idx];
  const utter = new SpeechSynthesisUtterance(text);
  utter.voice = voice;
  utter.lang = bcp47;
  utter.rate = 0.9; // a touch slower than default reads far more clearly
  utter.pitch = 1;
  utter.volume = 1;
  window.speechSynthesis.speak(utter);
  return { spoke: true, voiceName: voice.name, voiceCount: candidates.length, voiceIndex: idx };
}

function cycleVoice(bcp47) {
  const candidates = candidateVoices(bcp47);
  if (candidates.length <= 1) return false;
  voiceIndexByLang[bcp47] = ((voiceIndexByLang[bcp47] || 0) + 1) % candidates.length;
  return true;
}

async function startWalkthrough(code) {
  currentLang = LANGUAGES.find((l) => l.code === code);
  currentStep = 0;
  document.getElementById("langScreen").classList.add("hidden");
  document.getElementById("walkScreen").classList.remove("hidden");
  renderDots();
  await ensureVoicesLoaded();
  showStep();
}

function renderDots() {
  const dots = document.getElementById("stepDots");
  dots.innerHTML = STEPS.map((_, i) => `<span class="${i === currentStep ? "active" : ""}"></span>`).join("");
}

function showStep() {
  const step = STEPS[currentStep];
  const text = step.text[currentLang.code] || step.text.en;

  document.getElementById("stepProgress").textContent = `STEP ${currentStep + 1} / ${STEPS.length}`;
  document.getElementById("stepIcon").textContent = step.icon;
  const caption = document.getElementById("stepCaption");
  caption.textContent = text;
  caption.dir = currentLang.rtl ? "rtl" : "ltr";

  document.getElementById("prevBtn").disabled = currentStep === 0;
  const isLast = currentStep === STEPS.length - 1;
  document.getElementById("nextBtn").textContent = isLast ? "Done" : "Next →";
  document.getElementById("finishBar").classList.toggle("hidden", !isLast);
  renderDots();

  const result = speak(text, currentLang.bcp47);
  const note = document.getElementById("voiceNote");
  const voiceBtn = document.getElementById("cycleVoiceBtn");
  if (!result.spoke) {
    note.textContent = "Spoken narration isn't available in this language on this device — captions above still guide you through each step.";
    note.classList.remove("hidden");
    voiceBtn.classList.add("hidden");
  } else {
    note.classList.add("hidden");
    voiceBtn.classList.remove("hidden");
  }
}

document.getElementById("nextBtn").addEventListener("click", () => {
  if (currentStep < STEPS.length - 1) {
    currentStep++;
    showStep();
  }
});
document.getElementById("prevBtn").addEventListener("click", () => {
  if (currentStep > 0) {
    currentStep--;
    showStep();
  }
});
document.getElementById("replayBtn").addEventListener("click", () => {
  const step = STEPS[currentStep];
  speak(step.text[currentLang.code] || step.text.en, currentLang.bcp47);
});
document.getElementById("cycleVoiceBtn").addEventListener("click", () => {
  const switched = cycleVoice(currentLang.bcp47);
  const step = STEPS[currentStep];
  const text = step.text[currentLang.code] || step.text.en;
  const note = document.getElementById("voiceNote");
  if (!switched) {
    note.textContent = "Only one voice is installed for this language on your device — nothing else to switch to here.";
    note.classList.remove("hidden");
  } else {
    note.classList.add("hidden");
  }
  speak(text, currentLang.bcp47);
});
document.getElementById("changeLangBtn").addEventListener("click", () => {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  document.getElementById("walkScreen").classList.add("hidden");
  document.getElementById("langScreen").classList.remove("hidden");
});

// Chrome loads voices asynchronously; re-render is unnecessary since we look
// up the voice fresh on every speak() call, but we wait once up front so the
// very first utterance isn't silently skipped due to an empty voice list.
if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => { voicesReady = true; };
}

renderLangGrid();
