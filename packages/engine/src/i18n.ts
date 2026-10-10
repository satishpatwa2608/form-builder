import type { FormDefinition, FormField, RuleAction } from './types';
import { parseCsv } from './import-form';

/**
 * Forms in several languages.
 *
 * A form is written in one language (its default). Each other language is a
 * list of translations keyed by what is being translated: `field.email.label`,
 * `field.state.option.KL`, `form.success`. A translation that is missing falls
 * back to the default language, so a half-translated form still works.
 *
 * The words the form app itself says ("Submit", "is required") come from the
 * catalogue below. English, Hindi and Arabic are built in; for any other
 * language they are translated with the form, under `ui.<key>`.
 */

/** Text the form app and the validator say themselves. `{label}`, `{n}` are filled in. */
export const UI_TEXT = {
  en: {
    required: '{label} is required',
    minLength: 'Must be at least {n} characters',
    maxLength: 'Must be at most {n} characters',
    format: '{label} is not in the expected format',
    option: 'Select a valid option',
    email: 'Enter a valid email address',
    number: 'Enter a number',
    min: 'Must be at least {n}',
    max: 'Must be at most {n}',
    signAgain: 'Sign again',
    tooLong: 'This answer is too long',
    date: 'Enter a valid date',
    time: 'Enter a time, for example 14:30',
    month: 'Choose a month',
    url: 'Enter a web address starting with https://',
    colour: 'Choose a colour',
    selectMin: 'Select at least {n}',
    selectMax: 'Select at most {n}',
    filesMax: 'Attach at most {n} files',
    captcha: 'Please complete the verification',
    consent: 'Please accept to continue',
    sign: 'Please sign',
    rowsRequired: 'Add at least one row to {label}',
    rowsMin: 'Add at least {n} rows',
    rowsMax: 'No more than {n} rows',
    submit: 'Submit',
    submitting: 'Submitting…',
    next: 'Next',
    back: 'Back',
    notAnswered: 'Not answered',
    checkAnswers: 'Check your answers',
    checkAnswersHint: 'Nothing has been sent yet. Change anything that is not right, then submit.',
    noneAdded: 'None added',
    change: 'Change {label}',
    thankYou: 'Thank you. Your response has been submitted.',
    loading: 'Loading form…',
    loadFailed: 'Could not load this form.',
    unavailable: 'This form is not available.',
    lookupNeeds: 'Fill in the fields this looks up by first.',
    lookupNone: 'Nothing was found.',
    lookupFailed: 'That could not be looked up. Please try again.',
    submitFailed: 'Submission failed. Please try again.',
    verifyFailed: 'Verification failed. Please try again.',
    searchSelect: 'Search and select...',
    select: 'Select...',
    signed: 'signed',
    notSigned: 'not signed yet',
    typeToSign: 'Or type your name to sign {label}',
    typeName: 'Or type your name',
    uploadFiles: 'Upload files',
    uploadFile: 'Upload a file',
    addAnother: 'Add another',
    row: '{label} row {n}',
    removeRow: 'Remove row {n} of {label}',
    removeThisRow: 'Remove this row',
    nothingAdded: 'Nothing added yet.',
    needsAttention: '(needs attention)',
    decrease: 'Decrease {label}',
    increase: 'Increase {label}',
    terms: 'Terms',
    language: 'Language',
    fixOne: 'Please fix this field:',
    fixMany: 'Please fix these {n} fields:',
    changeShort: 'Change',
    tab: 'Tab {n}',
    panel: 'Panel {n}',
    notRobot: "I'm not a robot",
    invisibleCheck: 'Invisible verification (test mode) runs when you submit.',
    invalid: 'Invalid',
    saveLater: 'Save and continue later',
    saving: 'Saving…',
    savedLink: 'Saved. Use this private link to continue on any device within 30 days - anyone with it can see your answers:',
    copyLink: 'Copy link',
    welcomeBack: 'Welcome back - your saved answers are filled in. Attachments need to be added again.',
    closedDefault: 'This form is closed and no longer takes answers.',
    continueLink: 'Link to continue later',
    keptAnswers: 'We kept the answers you gave here earlier. Attachments need to be added again.',
    startAgain: 'Start again',
    keptAsYouGo: 'Your answers are kept on this device as you go.',
    submitAnother: 'Submit another response',
    clear: 'Clear',
    reference: 'Your reference number is {ref}. Please quote it if you contact us about this.',
    yourSignature: 'Your signature',
    yes: 'Yes',
    no: 'No',
    codeSendEmail: 'Send me a code to confirm this email address',
    codeSendPhone: 'Send me a code to confirm this number',
    codeBoxEmail: 'Code sent to your email address',
    codeBoxPhone: 'Code sent to your number',
    codePlaceholder: '6-digit code',
    codeConfirm: 'Confirm',
    codeAgain: 'Send it again',
    codeSent: 'We sent a 6-digit code. It works for 10 minutes.',
    codeDoneEmail: 'This email address is confirmed.',
    codeDonePhone: 'This number is confirmed.',
    codeFailed: 'Something went wrong. Try again.',
  },
  hi: {
    required: '{label} आवश्यक है',
    minLength: 'कम से कम {n} अक्षर होने चाहिए',
    maxLength: 'अधिकतम {n} अक्षर हो सकते हैं',
    format: '{label} सही प्रारूप में नहीं है',
    option: 'एक मान्य विकल्प चुनें',
    email: 'एक मान्य ईमेल पता दर्ज करें',
    number: 'एक संख्या दर्ज करें',
    min: 'कम से कम {n} होना चाहिए',
    max: 'अधिकतम {n} हो सकता है',
    signAgain: 'फिर से हस्ताक्षर करें',
    tooLong: 'यह उत्तर बहुत लंबा है',
    date: 'एक मान्य तारीख दर्ज करें',
    time: 'समय दर्ज करें, जैसे 14:30',
    month: 'एक महीना चुनें',
    url: 'https:// से शुरू होने वाला वेब पता दर्ज करें',
    colour: 'एक रंग चुनें',
    selectMin: 'कम से कम {n} चुनें',
    selectMax: 'अधिकतम {n} चुनें',
    filesMax: 'अधिकतम {n} फ़ाइलें संलग्न करें',
    captcha: 'कृपया सत्यापन पूरा करें',
    consent: 'आगे बढ़ने के लिए कृपया स्वीकार करें',
    sign: 'कृपया हस्ताक्षर करें',
    rowsRequired: '{label} में कम से कम एक पंक्ति जोड़ें',
    rowsMin: 'कम से कम {n} पंक्तियाँ जोड़ें',
    rowsMax: '{n} से अधिक पंक्तियाँ नहीं',
    submit: 'जमा करें',
    submitting: 'जमा हो रहा है…',
    next: 'आगे',
    back: 'पीछे',
    notAnswered: 'उत्तर नहीं दिया',
    checkAnswers: 'अपने उत्तर जाँचें',
    checkAnswersHint: 'अभी कुछ भी भेजा नहीं गया है। जो सही नहीं है उसे बदलें, फिर जमा करें।',
    noneAdded: 'कुछ नहीं जोड़ा गया',
    change: '{label} बदलें',
    thankYou: 'धन्यवाद। आपका उत्तर जमा हो गया है।',
    loading: 'फ़ॉर्म लोड हो रहा है…',
    loadFailed: 'यह फ़ॉर्म लोड नहीं हो सका।',
    unavailable: 'यह फ़ॉर्म उपलब्ध नहीं है।',
    lookupNeeds: 'पहले वे फ़ील्ड भरें जिनसे यह खोजा जाता है।',
    lookupNone: 'कुछ नहीं मिला।',
    lookupFailed: 'यह खोजा नहीं जा सका। कृपया फिर से प्रयास करें।',
    submitFailed: 'जमा नहीं हो सका। कृपया फिर से प्रयास करें।',
    verifyFailed: 'सत्यापन विफल रहा। कृपया फिर से प्रयास करें।',
    searchSelect: 'खोजें और चुनें...',
    select: 'चुनें...',
    signed: 'हस्ताक्षर किया गया',
    notSigned: 'अभी हस्ताक्षर नहीं किया',
    typeToSign: 'या {label} पर हस्ताक्षर के लिए अपना नाम लिखें',
    typeName: 'या अपना नाम लिखें',
    uploadFiles: 'फ़ाइलें अपलोड करें',
    uploadFile: 'फ़ाइल अपलोड करें',
    addAnother: 'एक और जोड़ें',
    row: '{label} पंक्ति {n}',
    removeRow: '{label} की पंक्ति {n} हटाएँ',
    removeThisRow: 'यह पंक्ति हटाएँ',
    nothingAdded: 'अभी कुछ नहीं जोड़ा गया।',
    needsAttention: '(ध्यान दें)',
    decrease: '{label} घटाएँ',
    increase: '{label} बढ़ाएँ',
    terms: 'शर्तें',
    language: 'भाषा',
    fixOne: 'कृपया यह फ़ील्ड ठीक करें:',
    fixMany: 'कृपया ये {n} फ़ील्ड ठीक करें:',
    changeShort: 'बदलें',
    tab: 'टैब {n}',
    panel: 'पैनल {n}',
    notRobot: "मैं रोबोट नहीं हूँ",
    invisibleCheck: 'अदृश्य सत्यापन (परीक्षण मोड) जमा करते समय चलता है।',
    invalid: 'अमान्य',
    saveLater: 'सहेजें और बाद में जारी रखें',
    saving: 'सहेजा जा रहा है…',
    savedLink: 'सहेज लिया गया। 30 दिनों के भीतर किसी भी डिवाइस पर जारी रखने के लिए इस निजी लिंक का उपयोग करें - जिसके पास यह लिंक है वह आपके उत्तर देख सकता है:',
    copyLink: 'लिंक कॉपी करें',
    welcomeBack: 'वापसी पर स्वागत है - आपके सहेजे गए उत्तर भर दिए गए हैं। संलग्नक फिर से जोड़ने होंगे।',
    closedDefault: 'यह फ़ॉर्म बंद हो गया है और अब उत्तर नहीं लेता।',
    continueLink: 'बाद में जारी रखने का लिंक',
    keptAnswers: 'आपने पहले यहाँ जो उत्तर दिए थे, वे हमने रखे हैं। संलग्नक फिर से जोड़ने होंगे।',
    startAgain: 'फिर से शुरू करें',
    keptAsYouGo: 'आपके उत्तर इस डिवाइस पर साथ-साथ सहेजे जा रहे हैं।',
    submitAnother: 'एक और उत्तर जमा करें',
    clear: 'साफ़ करें',
    reference: 'आपका संदर्भ नंबर {ref} है। इस बारे में हमसे संपर्क करते समय कृपया इसे बताएँ।',
    yourSignature: 'आपके हस्ताक्षर',
    yes: 'हाँ',
    no: 'नहीं',
    codeSendEmail: 'इस ईमेल पते की पुष्टि के लिए मुझे कोड भेजें',
    codeSendPhone: 'इस नंबर की पुष्टि के लिए मुझे कोड भेजें',
    codeBoxEmail: 'आपके ईमेल पते पर भेजा गया कोड',
    codeBoxPhone: 'आपके नंबर पर भेजा गया कोड',
    codePlaceholder: '6 अंकों का कोड',
    codeConfirm: 'पुष्टि करें',
    codeAgain: 'दोबारा भेजें',
    codeSent: 'हमने 6 अंकों का कोड भेजा है। यह 10 मिनट तक मान्य है।',
    codeDoneEmail: 'इस ईमेल पते की पुष्टि हो गई है।',
    codeDonePhone: 'इस नंबर की पुष्टि हो गई है।',
    codeFailed: 'कुछ गड़बड़ हो गई। फिर से कोशिश करें।',
  },
  ar: {
    required: '{label} مطلوب',
    minLength: 'يجب ألا يقل عن {n} أحرف',
    maxLength: 'يجب ألا يزيد على {n} أحرف',
    format: '{label} ليس بالصيغة المتوقعة',
    option: 'اختر خيارًا صالحًا',
    email: 'أدخل عنوان بريد إلكتروني صالحًا',
    number: 'أدخل رقمًا',
    min: 'يجب ألا يقل عن {n}',
    max: 'يجب ألا يزيد على {n}',
    signAgain: 'وقّع مرة أخرى',
    tooLong: 'هذه الإجابة طويلة جدًا',
    date: 'أدخل تاريخًا صالحًا',
    time: 'أدخل وقتًا، مثل 14:30',
    month: 'اختر شهرًا',
    url: 'أدخل عنوان ويب يبدأ بـ https://',
    colour: 'اختر لونًا',
    selectMin: 'اختر {n} على الأقل',
    selectMax: 'اختر {n} على الأكثر',
    filesMax: 'أرفق {n} ملفات على الأكثر',
    captcha: 'يرجى إكمال التحقق',
    consent: 'يرجى الموافقة للمتابعة',
    sign: 'يرجى التوقيع',
    rowsRequired: 'أضف صفًا واحدًا على الأقل إلى {label}',
    rowsMin: 'أضف {n} صفوف على الأقل',
    rowsMax: 'لا أكثر من {n} صفوف',
    submit: 'إرسال',
    submitting: 'جارٍ الإرسال…',
    next: 'التالي',
    back: 'السابق',
    notAnswered: 'لم تتم الإجابة',
    checkAnswers: 'راجع إجاباتك',
    checkAnswersHint: 'لم يُرسل شيء بعد. غيّر ما ليس صحيحًا ثم أرسل.',
    noneAdded: 'لم تتم إضافة شيء',
    change: 'تغيير {label}',
    thankYou: 'شكرًا لك. تم إرسال إجابتك.',
    loading: 'جارٍ تحميل النموذج…',
    loadFailed: 'تعذّر تحميل هذا النموذج.',
    unavailable: 'هذا النموذج غير متاح.',
    lookupNeeds: 'املأ أولًا الحقول التي يتم البحث بها.',
    lookupNone: 'لم يتم العثور على شيء.',
    lookupFailed: 'تعذّر البحث. يرجى المحاولة مرة أخرى.',
    submitFailed: 'فشل الإرسال. يرجى المحاولة مرة أخرى.',
    verifyFailed: 'فشل التحقق. يرجى المحاولة مرة أخرى.',
    searchSelect: 'ابحث واختر...',
    select: 'اختر...',
    signed: 'تم التوقيع',
    notSigned: 'لم يتم التوقيع بعد',
    typeToSign: 'أو اكتب اسمك للتوقيع على {label}',
    typeName: 'أو اكتب اسمك',
    uploadFiles: 'رفع ملفات',
    uploadFile: 'رفع ملف',
    addAnother: 'إضافة آخر',
    row: '{label} الصف {n}',
    removeRow: 'إزالة الصف {n} من {label}',
    removeThisRow: 'إزالة هذا الصف',
    nothingAdded: 'لم تتم إضافة شيء بعد.',
    needsAttention: '(يحتاج إلى انتباه)',
    decrease: 'إنقاص {label}',
    increase: 'زيادة {label}',
    terms: 'الشروط',
    language: 'اللغة',
    fixOne: 'يرجى تصحيح هذا الحقل:',
    fixMany: 'يرجى تصحيح هذه الحقول ({n}):',
    changeShort: 'تغيير',
    tab: 'علامة التبويب {n}',
    panel: 'اللوحة {n}',
    notRobot: "أنا لست روبوتًا",
    invisibleCheck: 'يعمل التحقق غير المرئي (وضع الاختبار) عند الإرسال.',
    invalid: 'غير صالح',
    saveLater: 'حفظ والمتابعة لاحقًا',
    saving: 'جارٍ الحفظ…',
    savedLink: 'تم الحفظ. استخدم هذا الرابط الخاص للمتابعة على أي جهاز خلال 30 يومًا - أي شخص لديه الرابط يمكنه رؤية إجاباتك:',
    copyLink: 'نسخ الرابط',
    welcomeBack: 'مرحبًا بعودتك - تم ملء إجاباتك المحفوظة. يجب إضافة المرفقات مرة أخرى.',
    closedDefault: 'هذا النموذج مغلق ولم يعد يستقبل إجابات.',
    continueLink: 'رابط المتابعة لاحقًا',
    keptAnswers: 'احتفظنا بالإجابات التي قدمتها هنا سابقًا. يجب إضافة المرفقات مرة أخرى.',
    startAgain: 'البدء من جديد',
    keptAsYouGo: 'تُحفظ إجاباتك على هذا الجهاز أثناء تقدمك.',
    submitAnother: 'إرسال إجابة أخرى',
    clear: 'مسح',
    reference: 'رقمك المرجعي هو {ref}. يرجى ذكره إذا تواصلت معنا بهذا الشأن.',
    yourSignature: 'توقيعك',
    yes: 'نعم',
    no: 'لا',
    codeSendEmail: 'أرسل لي رمزًا لتأكيد هذا البريد الإلكتروني',
    codeSendPhone: 'أرسل لي رمزًا لتأكيد هذا الرقم',
    codeBoxEmail: 'الرمز المرسل إلى بريدك الإلكتروني',
    codeBoxPhone: 'الرمز المرسل إلى رقمك',
    codePlaceholder: 'رمز من 6 أرقام',
    codeConfirm: 'تأكيد',
    codeAgain: 'أرسله مرة أخرى',
    codeSent: 'أرسلنا رمزًا من 6 أرقام. يبقى صالحًا لمدة 10 دقائق.',
    codeDoneEmail: 'تم تأكيد هذا البريد الإلكتروني.',
    codeDonePhone: 'تم تأكيد هذا الرقم.',
    codeFailed: 'حدث خطأ ما. حاول مرة أخرى.',
  },
} as const;

export type UiKey = keyof (typeof UI_TEXT)['en'];
export const UI_KEYS = Object.keys(UI_TEXT.en) as UiKey[];

/** Languages offered when adding one to a form, with the name each calls itself. */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  hi: 'हिन्दी',
  bn: 'বাংলা',
  pa: 'ਪੰਜਾਬੀ',
  gu: 'ગુજરાતી',
  or: 'ଓଡ଼ିଆ',
  ta: 'தமிழ்',
  te: 'తెలుగు',
  kn: 'ಕನ್ನಡ',
  ml: 'മലയാളം',
  mr: 'मराठी',
  ur: 'اردو',
  ar: 'العربية',
  fr: 'Français',
  es: 'Español',
  de: 'Deutsch',
  pt: 'Português',
};
const RTL = new Set(['ar', 'ur', 'he', 'fa']);
const CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

export const isLanguageCode = (code: string): boolean => CODE.test(code);
/** Written right to left. */
export const isRtl = (language: string | undefined): boolean => RTL.has((language ?? '').split('-')[0]!.toLowerCase());
export const languageName = (code: string): string => LANGUAGE_NAMES[code] ?? LANGUAGE_NAMES[code.split('-')[0]!] ?? code;

/** The languages a form is offered in, its own first. */
export function languagesOf(def: Pick<FormDefinition, 'languages'>): string[] {
  const own = def.languages?.default || 'en';
  return [own, ...(def.languages?.others ?? []).filter((l) => l !== own)];
}

/** The language to show for what was asked for: that one if the form has it, else the form's own. */
export function pickLanguage(def: Pick<FormDefinition, 'languages'>, wanted: string | undefined | null): string {
  const offered = languagesOf(def);
  if (!wanted) return offered[0]!;
  const exact = offered.find((l) => l.toLowerCase() === wanted.toLowerCase());
  // "hi-IN" asked for and "hi" offered is a match.
  return exact ?? offered.find((l) => l.split('-')[0]!.toLowerCase() === wanted.split('-')[0]!.toLowerCase()) ?? offered[0]!;
}

export type Say = (key: UiKey, vars?: Record<string, string | number>) => string;

/**
 * What the form app says in a language: the form's own translation of it
 * (`ui.<key>`) first, then the built-in one, then English.
 */
export function uiText(language: string | undefined, def?: Pick<FormDefinition, 'translations'>): Say {
  const lang = language ?? 'en';
  const own = def?.translations?.[lang] ?? {};
  const builtIn = (UI_TEXT as Record<string, Partial<Record<UiKey, string>>>)[lang] ?? (UI_TEXT as Record<string, Partial<Record<UiKey, string>>>)[lang.split('-')[0]!] ?? {};
  return (key, vars = {}) => (own[`ui.${key}`] || builtIn[key] || UI_TEXT.en[key]).replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

export interface TranslatableString {
  key: string;
  /** The text in the form's own language. */
  text: string;
  /** Where it appears, for the translator. */
  context: string;
}

const MESSAGE_KINDS = ['required', 'minLength', 'maxLength', 'min', 'max', 'pattern'] as const;
const ruleActions = (def: Pick<FormDefinition, 'rules'>): { key: string; action: RuleAction; rule: string }[] =>
  (def.rules ?? []).flatMap((r) => [
    ...r.then.map((action, i) => ({ key: `rule.${r.id}.then.${i}`, action, rule: r.name || r.id })),
    ...(r.else ?? []).map((action, i) => ({ key: `rule.${r.id}.else.${i}`, action, rule: r.name || r.id })),
  ]);

/** Everything on a form a translator needs to translate, in the order it appears. */
export function translatableStrings(def: FormDefinition): TranslatableString[] {
  const out: TranslatableString[] = [];
  const add = (key: string, text: unknown, context: string) => {
    if (typeof text === 'string' && text.trim()) out.push({ key, text, context });
  };
  add('form.name', def.name, 'The form\'s title');
  for (const f of def.fields) {
    const what = f.label || f.name;
    const k = `field.${f.name}`;
    add(`${k}.label`, f.label, 'Label');
    add(`${k}.placeholder`, f.placeholder, `Placeholder of "${what}"`);
    add(`${k}.helpText`, f.helpText, `Help text of "${what}"`);
    add(`${k}.description`, f.props?.description, `Description of "${what}"`);
    add(`${k}.text`, f.props?.text, `Terms of "${what}"`);
    add(`${k}.content`, f.type === 'HTML' ? f.props?.content : undefined, `Content of "${what}"`);
    add(`${k}.alt`, f.props?.alt, `Description of the picture "${what}"`);
    if (f.dataSource?.type === 'STATIC') for (const o of f.dataSource.options ?? []) add(`${k}.option.${o.value}`, o.label, `Choice of "${what}"`);
    for (const kind of MESSAGE_KINDS) add(`${k}.message.${kind}`, f.validation?.messages?.[kind], `Message of "${what}"`);
  }
  for (const { key, action, rule } of ruleActions(def)) if (action.type === 'ERROR') add(key, action.message, `Message of the rule "${rule}"`);
  for (const e of def.events ?? []) e.do.forEach((a, i) => a.type === 'SHOW_MESSAGE' && add(`event.${e.id}.${i}`, a.message, 'Message shown after submitting'));
  add('form.submit', def.actions?.submit?.label, 'The submit button');
  add('form.cancel', def.actions?.cancel?.label, 'The cancel button');
  add('form.success', def.submission.success?.message, 'Shown after a response is sent');
  add('form.closed', def.closedMessage, 'Shown once the form has closed');
  add('form.documentTitle', def.document?.title, 'Title of the PDF');
  add('form.documentFooter', def.document?.footer, 'Foot of each page of the PDF');
  return out;
}

/**
 * The form in one of its languages: every piece of its wording replaced by
 * its translation where there is one. Names, values and rules are untouched,
 * so answers are stored the same whatever language they were given in.
 */
export function localize<T extends FormDefinition>(def: T, language: string | undefined): T {
  const lang = pickLanguage(def, language);
  const table = lang === languagesOf(def)[0] ? undefined : def.translations?.[lang];
  if (!table || !Object.keys(table).length) return def;
  const tr = (key: string, text: string | undefined): string | undefined => (typeof text === 'string' && table[key]?.trim() ? table[key] : text);
  const field = (f: FormField): FormField => {
    const k = `field.${f.name}`;
    const props = f.props
      ? {
          ...f.props,
          ...(typeof f.props.description === 'string' ? { description: tr(`${k}.description`, f.props.description) } : {}),
          ...(typeof f.props.text === 'string' ? { text: tr(`${k}.text`, f.props.text) } : {}),
          ...(f.type === 'HTML' && typeof f.props.content === 'string' ? { content: tr(`${k}.content`, f.props.content) } : {}),
          ...(typeof f.props.alt === 'string' ? { alt: tr(`${k}.alt`, f.props.alt) } : {}),
        }
      : undefined;
    const messages = f.validation?.messages ? Object.fromEntries(Object.entries(f.validation.messages).map(([kind, text]) => [kind, tr(`${k}.message.${kind}`, text)])) : undefined;
    return {
      ...f,
      ...(f.label !== undefined ? { label: tr(`${k}.label`, f.label) } : {}),
      ...(f.placeholder !== undefined ? { placeholder: tr(`${k}.placeholder`, f.placeholder) } : {}),
      ...(f.helpText !== undefined ? { helpText: tr(`${k}.helpText`, f.helpText) } : {}),
      ...(props ? { props } : {}),
      ...(messages ? { validation: { ...f.validation, messages } } : {}),
      ...(f.dataSource?.type === 'STATIC' && f.dataSource.options ? { dataSource: { ...f.dataSource, options: f.dataSource.options.map((o) => ({ ...o, label: tr(`${k}.option.${o.value}`, o.label)! })) } } : {}),
    };
  };
  return {
    ...def,
    name: tr('form.name', def.name)!,
    fields: def.fields.map(field),
    ...(def.rules
      ? {
          rules: def.rules.map((r) => ({
            ...r,
            then: r.then.map((a, i) => (a.type === 'ERROR' ? { ...a, message: tr(`rule.${r.id}.then.${i}`, a.message)! } : a)),
            ...(r.else ? { else: r.else.map((a, i) => (a.type === 'ERROR' ? { ...a, message: tr(`rule.${r.id}.else.${i}`, a.message)! } : a)) } : {}),
          })),
        }
      : {}),
    ...(def.events ? { events: def.events.map((e) => ({ ...e, do: e.do.map((a, i) => (a.type === 'SHOW_MESSAGE' ? { ...a, message: tr(`event.${e.id}.${i}`, a.message)! } : a)) })) } : {}),
    ...(def.actions
      ? {
          actions: {
            ...def.actions,
            ...(def.actions.submit ? { submit: { ...def.actions.submit, label: tr('form.submit', def.actions.submit.label)! } } : {}),
            ...(def.actions.cancel ? { cancel: { ...def.actions.cancel, label: tr('form.cancel', def.actions.cancel.label)! } } : {}),
          },
        }
      : {}),
    submission: def.submission.success?.message ? { ...def.submission, success: { ...def.submission.success, message: tr('form.success', def.submission.success.message) } } : def.submission,
    ...(def.closedMessage ? { closedMessage: tr('form.closed', def.closedMessage) } : {}),
    ...(def.document ? { document: { ...def.document, ...(def.document.title ? { title: tr('form.documentTitle', def.document.title) } : {}), ...(def.document.footer ? { footer: tr('form.documentFooter', def.document.footer) } : {}) } } : {}),
  };
}

/** How much of a language is done: of the form's own wording, how many strings have a translation. */
export function translationProgress(def: FormDefinition, language: string): { done: number; total: number; missing: TranslatableString[] } {
  const strings = translatableStrings(def);
  const table = def.translations?.[language] ?? {};
  const missing = strings.filter((s) => !table[s.key]?.trim());
  return { done: strings.length - missing.length, total: strings.length, missing };
}

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** A cell that a spreadsheet would run as a formula is written so that it is read as text. */
const inert = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

/**
 * The form's wording as a spreadsheet for a translator: one row per string,
 * a column for the form's own language, and one for each other language. The
 * words the form app says itself follow, for languages that are not built in.
 */
export function translationsToCsv(def: FormDefinition): string {
  const [own, ...others] = languagesOf(def);
  const rows: string[][] = [['key', 'where', own!, ...others]];
  for (const s of translatableStrings(def)) rows.push([s.key, s.context, s.text, ...others.map((l) => def.translations?.[l]?.[s.key] ?? '')]);
  const needUi = others.filter((l) => !(l in UI_TEXT) && !(l.split('-')[0]! in UI_TEXT));
  if (needUi.length) for (const key of UI_KEYS) rows.push([`ui.${key}`, 'Said by the form itself', UI_TEXT.en[key], ...others.map((l) => def.translations?.[l]?.[`ui.${key}`] ?? '')]);
  return rows.map((r) => r.map((c) => cell(inert(c))).join(',')).join('\r\n') + '\r\n';
}

/**
 * Translations read back from that spreadsheet. Only keys the form has and
 * languages the form offers are taken; everything else is reported, not kept.
 */
export function translationsFromCsv(def: FormDefinition, csv: string): { translations: Record<string, Record<string, string>>; notes: string[] } {
  const rows = parseCsv(csv, 5000);
  const notes: string[] = [];
  const [header, ...body] = rows;
  if (!header || header[0]?.trim().toLowerCase() !== 'key') return { translations: def.translations ?? {}, notes: ['The first column must be "key". Export the translations first and fill in that file.'] };
  const others = languagesOf(def).slice(1);
  const columns = header.map((h) => h.trim());
  const known = new Set([...translatableStrings(def).map((s) => s.key), ...UI_KEYS.map((k) => `ui.${k}`)]);
  const translations: Record<string, Record<string, string>> = Object.fromEntries(others.map((l) => [l, { ...(def.translations?.[l] ?? {}) }]));
  for (const l of columns.slice(3)) if (l && !others.includes(l)) notes.push(`The column "${l}" is not a language of this form and was ignored.`);
  let unknown = 0;
  let taken = 0;
  for (const row of body) {
    const key = (row[0] ?? '').trim();
    if (!key) continue;
    if (!known.has(key)) {
      unknown++;
      continue;
    }
    for (const lang of others) {
      const at = columns.indexOf(lang);
      if (at < 3) continue;
      const text = (row[at] ?? '').replace(/^'(?=[=+\-@])/, '').slice(0, 5000);
      if (text.trim()) {
        translations[lang]![key] = text;
        taken++;
      } else delete translations[lang]![key];
    }
  }
  if (unknown) notes.push(`${unknown} row${unknown === 1 ? '' : 's'} had a key this form does not have (the form has changed since the file was exported) and ${unknown === 1 ? 'was' : 'were'} ignored.`);
  notes.unshift(`${taken} translation${taken === 1 ? '' : 's'} read.`);
  return { translations, notes };
}

const xmlText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fromXml = (text: string) =>
  text
    // Inline markup a translation tool may add is not ours to keep: only its words are.
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

/**
 * The form's wording for one language as an XLIFF 1.2 file, the format translation agencies and their tools
 * exchange: each piece of wording is a unit with its source text, the translation so far, and a note saying
 * where on the form it is.
 */
export function translationsToXliff(def: FormDefinition, language: string): string {
  const [own] = languagesOf(def);
  const units = translatableStrings(def).map((s) => {
    const target = def.translations?.[language]?.[s.key];
    return `      <trans-unit id="${xmlText(s.key)}" xml:space="preserve">\n        <source>${xmlText(s.text)}</source>\n        <target${target ? ' state="translated"' : ' state="new"'}>${xmlText(target ?? '')}</target>\n        <note>${xmlText(s.context)}</note>\n      </trans-unit>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">\n  <file original="${xmlText(def.code)}" datatype="plaintext" source-language="${xmlText(own!)}" target-language="${xmlText(language)}">\n    <body>\n${units.join('\n')}\n    </body>\n  </file>\n</xliff>\n`;
}

/**
 * Translations read back from an XLIFF file. The language is the file's own target language, which must be one
 * the form offers; only wording the form still has is taken, and the rest is reported.
 */
export function translationsFromXliff(def: FormDefinition, xml: string): { translations: Record<string, Record<string, string>>; notes: string[] } {
  const keep = def.translations ?? {};
  if (xml.length > 5_000_000) return { translations: keep, notes: ['The file is too large.'] };
  const language = /<file\b[^>]*\btarget-language\s*=\s*"([^"]+)"/.exec(xml)?.[1];
  const others = languagesOf(def).slice(1);
  if (!language) return { translations: keep, notes: ['This is not an XLIFF file with a target language. Export one first and have that file translated.'] };
  if (!others.includes(language)) return { translations: keep, notes: [`The file is for "${language}", which is not a language of this form.`] };
  const known = new Set(translatableStrings(def).map((s) => s.key));
  const next = { ...(keep[language] ?? {}) };
  let taken = 0;
  let unknown = 0;
  for (const unit of xml.matchAll(/<trans-unit\b[^>]*\bid\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/trans-unit>/g)) {
    const key = fromXml(unit[1]!);
    if (!known.has(key)) {
      unknown++;
      continue;
    }
    const target = /<target\b[^>]*>([\s\S]*?)<\/target>/.exec(unit[2]!)?.[1];
    const text = target === undefined ? '' : fromXml(target).slice(0, 5000);
    if (text.trim()) {
      next[key] = text;
      taken++;
    } else delete next[key];
  }
  const notes = [`${taken} translation${taken === 1 ? '' : 's'} into ${language} read.`];
  if (unknown) notes.push(`${unknown} unit${unknown === 1 ? '' : 's'} had a key this form does not have (the form has changed since the file was exported) and ${unknown === 1 ? 'was' : 'were'} ignored.`);
  return { translations: { ...keep, [language]: next }, notes };
}
