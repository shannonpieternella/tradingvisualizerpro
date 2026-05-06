// ─────────────────────────────────────────────────────────────────────────────
// i18n strings — EN + NL side-by-side for atomic edits.
//
// HOW THIS WORKS:
//   Every string lives in ONE place with both languages adjacent. When you ask
//   "change the hero title to X", I update BOTH the en and nl keys in the same
//   edit — no re-translating the whole site. Add a new string by adding both
//   `en` + `nl` versions in the same object.
//
// USAGE:
//   import { useT } from "../contexts/LanguageContext.jsx";
//   const t = useT();
//   <h1>{t("hero_title")}</h1>
//
//   For interpolation:
//   t("welcome", { name: "Levi" })  → "Welcome, Levi"
//
// FALLBACK:
//   If a key is missing in the active language, falls back to EN.
// ─────────────────────────────────────────────────────────────────────────────

export const TRANSLATIONS = {
  // ── NAV ───────────────────────────────────────────────────────────────────
  nav_how:       { en: "How it works",   nl: "Hoe het werkt" },
  nav_pricing:   { en: "Pricing",        nl: "Prijzen" },
  nav_faq:       { en: "FAQ",            nl: "FAQ" },
  nav_login:     { en: "Log in",         nl: "Inloggen" },
  nav_hire:      { en: "Hire your AI →", nl: "Hire je AI →" },

  // ── HERO ──────────────────────────────────────────────────────────────────
  hero_badge: {
    en: "AI ACTIVE · {markets} markets · {accuracy}% accuracy · {setups} setups",
    nl: "AI ACTIEF · {markets} markten · {accuracy}% accuracy · {setups} setups",
  },
  hero_title_1:    { en: "Trading without",                nl: "Trading zonder" },
  hero_title_2:    { en: "the human errors.",              nl: "de menselijke fouten." },
  hero_sub: {
    en: "24/7 monitoring. {markets} markets at once. Fixed-risk on every trade. Zero emotions.",
    nl: "24/7 monitoring. {markets} markten tegelijk. Fixed-risk per trade. Nul emoties.",
  },
  hero_sub_close: {
    en: "Discipline no human can sustain — for less than a weekly lunch.",
    nl: "Discipline die geen mens vol kan houden — voor minder dan een lunch per week.",
  },
  hero_cta_free: { en: "🚀 Start free — no credit card",      nl: "🚀 Test gratis — geen creditcard" },
  hero_cta_auto: { en: "⚡ Hire Hands-Off AI — €69/mo",        nl: "⚡ Direct hands-off — €69/mnd" },

  trust_30s:        { en: "⚡ 30s signup",            nl: "⚡ 30s registratie" },
  trust_money:      { en: "🔒 Your broker, your money", nl: "🔒 Jouw broker, jouw geld" },
  trust_pause:      { en: "🛑 Pause anytime",         nl: "🛑 Pauzeknop altijd actief" },
  trust_cancel:     { en: "↻ Cancel anytime",         nl: "↻ Cancel altijd" },

  ticker_label: { en: "LIVE WINS", nl: "LIVE WINS" },

  // ── PROBLEM SECTION ───────────────────────────────────────────────────────
  problem_tag:    { en: "THE BOTTLENECK",           nl: "DE BOTTLENECK" },
  problem_title_1: { en: "Strategy isn't",           nl: "Strategie is" },
  problem_title_2: { en: "the problem.",             nl: "niet" },          // strikethrough soft
  problem_title_3: { en: "Execution is.",            nl: "het probleem. Uitvoering wel." },
  problem_sub: {
    en: "Most retail traders have decent ideas. What they lack: 24/7 uptime, ironclad discipline, and time to execute every setup. An algorithm has all of that.",
    nl: "De meeste retail traders hebben prima ideeën. Wat ze missen: 24/7 uptime, ijzeren discipline, en de tijd om elke setup uit te voeren. Een algoritme heeft dat wel.",
  },

  problem_1_title: { en: "Best setups happen while you sleep", nl: "De beste setups gebeuren als je slaapt" },
  problem_1_desc: {
    en: "London open. New York close. Tokyo overlap. The biggest moves come at the most inconvenient times — and you miss them.",
    nl: "London open. New York close. Tokyo overlap. De grootste moves komen op de meest onhandige tijden — en jij mist ze.",
  },
  problem_2_title: { en: "Too much data to track manually",     nl: "Te veel data om handmatig te tracken" },
  problem_2_desc: {
    en: "BSL · SSL · Phase 2 · 6H Lock · Premium/Discount · 7 markets · 4 timeframes. Your brain can't handle this 24/7. An AI can.",
    nl: "BSL · SSL · Phase 2 · 6H Lock · Premium/Discount · 7 markten · 4 timeframes. Jouw brein kan dit niet 24/7 aan. Een AI wel.",
  },
  problem_3_title: { en: "Emotions destroy your P&L",           nl: "Emoties slopen je P&L" },
  problem_3_desc: {
    en: "FOMO. Revenge trades. Closing too early. Holding too long. You know what to do — but you don't do it. Classic trader-fail.",
    nl: "FOMO. Revenge trades. Te vroeg sluiten. Te lang vasthouden. Je weet wat je moet doen — maar je doet het niet. Klassieke trader-fail.",
  },
  problem_4_title: { en: "90% of retail traders keep losing",   nl: "90% van retail traders blijft verliezen" },
  problem_4_desc: {
    en: "Not because of bad ideas — because of bad execution. Without a system + discipline, you give your money to those who have it.",
    nl: "Niet door slechte ideeën — door slechte uitvoering. Wie geen system + discipline heeft, geeft geld weg aan wie het wel heeft.",
  },

  // ── SOLUTION ──────────────────────────────────────────────────────────────
  solution_tag:    { en: "THE SOLUTION",                   nl: "DE OPLOSSING" },
  solution_title_1: { en: "Risk management as a",          nl: "Risk management als" },
  solution_title_2: { en: "specialty.",                    nl: "specialiteit." },
  solution_sub_1: {
    en: "Same fixed-risk on every trade. Pre-defined Stop-Loss. Automatic BE-MOVE at TP2 — from that point on you can't lose on that trade. Losers stay small, winners (TP3 = 10R) run. That's why your account grows even in periods where individual trades lose.",
    nl: "Elke trade dezelfde fixed risk. Vooraf-gedefinieerde Stop-Loss. Automatische BE-MOVE bij TP2 — vanaf dat punt kan je geen verlies meer maken op die trade. Verliezen blijven klein, winners (TP3 = 10R) lopen door. Daardoor groeit je account ook in periodes waar individuele trades verliezen.",
  },
  solution_sub_2: {
    en: "A human cannot maintain this discipline — emotions always break through. An algorithm doesn't have that problem.",
    nl: "Een mens lukt deze discipline niet — emoties breken altijd door. Een algoritme heeft dat probleem niet.",
  },
  solution_markets_callout: {
    en: "And here's the kicker: your AI monitors {markets} markets simultaneously. Find me a human who can do that without missing 90% of the action.",
    nl: "En de kicker: je AI monitort {markets} markten tegelijk. Laat zien me één mens die dat kan zonder 90% van de action te missen.",
  },

  // Stats labels
  stat_accuracy: { en: "Historical accuracy",       nl: "Historische accuracy" },
  stat_setups:   { en: "Setups executed",           nl: "Setups uitgevoerd" },
  stat_wins:     { en: "Winning trades",            nl: "Winnende trades" },
  stat_runner:   { en: "Runner target TP3",         nl: "Runner-target TP3" },
  stat_uptime:   { en: "Uptime · 24/7/365",         nl: "Uptime · 24/7/365" },
  stat_markets:  { en: "Markets monitored at once", nl: "Markten gelijktijdig" },

  disclaimer: {
    en: "* Numbers from our public setup-log. Past performance is not a guarantee of future results. Trading involves risk. TradingVisualizer is a SaaS-tool — not investment advice.",
    nl: "* Cijfers uit ons publieke setup-log. Verleden prestaties geen garantie voor toekomstige. Trading brengt risico met zich mee. TradingVisualizer is een SaaS-tool — geen beleggingsadvies.",
  },

  // ── HOW IT WORKS ──────────────────────────────────────────────────────────
  how_tag:      { en: "FLOW",                         nl: "FLOW" },
  how_title_1:  { en: "Three steps.",                 nl: "Drie stappen." },
  how_title_2:  { en: "Done in 30 seconds.",          nl: "Klaar in 30 seconden." },

  how_1_title: { en: "Create your account",          nl: "Maak je account" },
  how_1_desc: {
    en: "30 seconds, no credit card. Your AI is online instantly and starts monitoring markets — no technical setup required.",
    nl: "30 seconden, geen creditcard. Je AI is direct online en begint markten te monitoren — geen technische setup nodig.",
  },
  how_2_title: { en: "AI finds the setups",          nl: "AI vindt de setups" },
  how_2_desc: {
    en: "Sweep-detection · Phase-2 windows · cycle-confluence. Every signal arrives ready-to-trade — entry, Stop-Loss, TP1, TP2, TP3 — in dashboard and Discord.",
    nl: "Sweep-detectie · Phase-2 windows · cycle-confluence. Je krijgt elk signaal kant-en-klaar — entry, Stop-Loss, TP1, TP2, TP3 — in dashboard én Discord.",
  },
  how_3_title: { en: "You decide who executes",      nl: "Jij kiest wie uitvoert" },
  how_3_desc: {
    en: "AI-Analyst tier: you execute manually on your own broker. Hands-Off AI: the AI handles end-to-end, including automatic BE-MOVE at TP2. You stay in control, always.",
    nl: "AI-Analist: jij voert zelf uit op je eigen broker. Hands-Off AI: de AI handelt end-to-end af, inclusief automatische BE-MOVE na TP2. Jij blijft altijd in control.",
  },

  // ── PRICING ───────────────────────────────────────────────────────────────
  pricing_tag:   { en: "PRICING",                  nl: "PRIJZEN" },
  pricing_title_1: { en: "What does your AI",      nl: "Wat doet jouw AI" },
  pricing_title_2: { en: "do for you?",            nl: "voor je?" },
  pricing_sub: {
    en: "Start free. Upgrade when the AI proves itself. Stop whenever you want.",
    nl: "Begin gratis. Upgrade als de AI zich bewijst. Stop wanneer je wil.",
  },

  tier_free_name:   { en: "Test tier",                  nl: "Test-tier" },
  tier_free_period: { en: "/forever",                   nl: "/altijd" },
  tier_free_tag:    { en: "Try without risk",           nl: "Probeer zonder risico" },
  tier_free_1:      { en: "1 winning trade per week",   nl: "1 winnende trade/week" },
  tier_free_2:      { en: "Live until first TP2 hits",  nl: "Live tot eerste TP2-hit" },
  tier_free_3:      { en: "Dashboard access",           nl: "Dashboard toegang" },
  tier_free_4:      { en: "All 7 markets visible",      nl: "Alle 7 markten zichtbaar" },
  tier_free_no1:    { en: "No Discord notifications",   nl: "Geen Discord meldingen" },
  tier_free_no2:    { en: "No broker execution",        nl: "Geen broker-uitvoering" },
  tier_free_btn:    { en: "Start free →",               nl: "Start gratis →" },
  tier_free_foot:   { en: "No credit card needed",      nl: "Geen creditcard nodig" },

  tier_signal_name:   { en: "AI-Analyst",                nl: "AI-Analist" },
  tier_signal_period: { en: "/mo",                       nl: "/mnd" },
  tier_signal_tag:    { en: "For traders who execute themselves", nl: "Voor wie zelf wil traden" },
  tier_signal_1:      { en: "Unlimited AI analyses",     nl: "Onbeperkt AI-analyses" },
  tier_signal_2:      { en: "All TFs · 6H · 90M · Daily", nl: "Alle TFs · 6H · 90M · Daily" },
  tier_signal_3:      { en: "Discord notifications instant", nl: "Discord meldingen direct" },
  tier_signal_4:      { en: "Full analysis history",     nl: "Volledige analyse-historie" },
  tier_signal_5:      { en: "You control entry-timing + lot size", nl: "Jij bepaalt entry-timing + lot" },
  tier_signal_no1:    { en: "AI doesn't execute trades", nl: "AI doet geen executie" },
  tier_signal_btn:    { en: "Start AI-Analyst →",        nl: "Start AI-Analist →" },
  tier_signal_foot:   { en: "Cancel anytime",            nl: "Cancel wanneer je wil" },

  tier_auto_badge:    { en: "⭐ MOST CHOSEN",             nl: "⭐ MEEST GEKOZEN" },
  tier_auto_name:     { en: "Hands-Off AI",              nl: "Hands-Off AI" },
  tier_auto_period:   { en: "/mo",                       nl: "/mnd" },
  tier_auto_tag:      { en: "Fully hands-off · AI works for you", nl: "Volledig hands-off · AI werkt voor je" },
  tier_auto_1:        { en: "Everything in AI-Analyst",  nl: "Alles van AI-Analist" },
  tier_auto_2:        { en: "AI executes trades automatically", nl: "AI voert trade automatisch uit" },
  tier_auto_3:        { en: "Auto SL + TP + BE-MOVE",    nl: "Auto SL + TP + BE-MOVE" },
  tier_auto_4:        { en: "Performance dashboard",     nl: "Performance dashboard" },
  tier_auto_5:        { en: "Balance graph + tracking",  nl: "Balance grafiek + tracking" },
  tier_auto_6:        { en: "Liquid Markets MT5 link",   nl: "Liquid Markets MT5 koppeling" },
  tier_auto_perf:     { en: "+ 10% performance fee on profit (HWM)", nl: "+ 10% perf-fee op winst (HWM)" },
  tier_auto_btn:      { en: "Hire your AI →",            nl: "Hire je AI →" },
  tier_auto_foot:     { en: "Cancel anytime · Pause button in dashboard", nl: "Cancel altijd · Pauzeknop in dashboard" },

  pricing_note: {
    en: "💡 Both paid plans include unlimited AI analyses. The difference: does your AI just do the thinking (€39), or also the execution on your broker (€69)?",
    nl: "💡 Beide betaalde plannen geven onbeperkt AI-analyses. Het verschil: doet je AI alleen het denkwerk (€39), of ook de uitvoering op je broker (€69)?",
  },

  // ── SECURITY ──────────────────────────────────────────────────────────────
  sec_tag:        { en: "YOUR CONTROL",                nl: "JOUW CONTROLE" },
  sec_title_1:    { en: "Your money.",                 nl: "Jouw geld." },
  sec_title_2:    { en: "Your broker.",                nl: "Jouw broker." },
  sec_title_3:    { en: "Your decisions.",             nl: "Jouw beslissingen." },
  sec_para: {
    en: "Your AI is a tool, not a wealth manager. Hands-Off uses your own Liquid Markets account — we never see your credentials, never have access to your money. We just send trade-instructions via MetaApi.",
    nl: "Je AI is een tool, geen vermogensbeheerder. Hands-Off gebruikt je eigen Liquid Markets account — wij zien je credentials nooit, krijgen nooit toegang tot je geld. We sturen alleen trade-instructies door via MetaApi.",
  },
  sec_li_1: { en: "🔒 Login goes directly to MetaApi (not to us)",      nl: "🔒 Login rechtstreeks naar MetaApi (niet naar ons)" },
  sec_li_2: { en: "🛑 Pause button in dashboard — all trades off instantly", nl: "🛑 Pauzeknop in dashboard — alle trades direct uit" },
  sec_li_3: { en: "👤 Close manually in MT5 whenever you want",         nl: "👤 Sluit handmatig in MT5 wanneer je wil" },
  sec_li_4: { en: "📜 SaaS tool, not investment advice",                nl: "📜 SaaS-tool, geen beleggingsadvies" },
  sec_li_5: { en: "💳 Stripe-processed payments, no card-data on our servers", nl: "💳 Stripe-verwerkte betalingen, never card-data on our servers" },
  sec_tag_saas: { en: "SaaS · No advice", nl: "SaaS · Geen advies" },

  // ── FAQ ───────────────────────────────────────────────────────────────────
  faq_tag:     { en: "FAQ",                            nl: "FAQ" },
  faq_title_1: { en: "What you still want to",         nl: "Wat je nog wil" },
  faq_title_2: { en: "know.",                          nl: "weten." },

  faq_1_q: { en: "Is this a trading signal service?", nl: "Is dit een trading signal service?" },
  faq_1_a: {
    en: "No. TradingVisualizer is a SaaS-tool — your AI assistant is software that analyzes market data and helps you make decisions. We don't provide investment advice and we're not a wealth manager. You remain 100% owner of your broker account, your money, and every trading decision.",
    nl: "Nee. TradingVisualizer is een SaaS-tool — je AI-assistent is software die markt-data analyseert en jou helpt beslissingen te nemen. Wij geven geen beleggingsadvies en zijn geen vermogensbeheerder. Jij blijft 100% eigenaar van je broker-account, je geld, en elke trading-beslissing.",
  },
  faq_2_q: { en: "Do I need trading experience?", nl: "Heb ik trading-ervaring nodig?" },
  faq_2_a: {
    en: "No. The AI does the analysis — you only choose who executes the trade: you (€39 AI-Analyst) or the AI (€69 Hands-Off). Many users start on AI-Analyst to learn the system by observing, then switch to Hands-Off once they're comfortable.",
    nl: "Nee. De AI doet de analyse — jij hoeft alleen te kiezen wie de trade uitvoert: jij (€39 AI-Analist) of de AI (€69 Hands-Off). Veel users beginnen op AI-Analist om het system te leren door te observeren, en switchen later naar Hands-Off zodra ze comfortabel zijn.",
  },
  faq_3_q: { en: "Which broker should I use?", nl: "Welke broker moet ik gebruiken?" },
  faq_3_a: {
    en: "For Hands-Off AI: a Liquid Markets MT5 account, free via our affiliate link. For AI-Analyst + Free: any broker — we just send analysis, you execute wherever you want.",
    nl: "Voor Hands-Off AI: een Liquid Markets MT5 account, gratis via onze affiliate-link. AI-Analist + Free: elke broker — wij sturen alleen analyse, jij voert uit waar je wil.",
  },
  faq_4_q: { en: "How does the Free tier work?", nl: "Hoe werkt de Free tier?" },
  faq_4_a: {
    en: "You get 1 winning trade per week — starting from your registration. You see it live in dashboard until the first TP2 hits. After that, 'rest' until Monday. No credit card, no card-data. Pure proof-of-concept without risk.",
    nl: "Je krijgt 1 winnende trade per week — vanaf je registratie. Je ziet 'm live in dashboard tot het eerste TP2 wordt gehit. Daarna 'rust' tot maandag. Geen creditcard, geen card-data. Pure proof-of-concept zonder risico.",
  },
  faq_5_q: { en: "What's the 10% performance fee?", nl: "Wat is de 10% performance fee?" },
  faq_5_a: {
    en: "Hands-Off AI only. If your AI generates profit, you pay 10% of net profit per month. With high-water mark: only on new highs — during a loss month or recovery below previous high: no fee. Fair and simple.",
    nl: "Alleen op Hands-Off AI. Als je AI winst voor je maakt, betaal je 10% van de netto-winst per maand. Met high-water mark: alleen op nieuwe hoogtepunten — bij verlies-maand of recovery onder vorige high: geen fee. Eerlijk en simpel.",
  },
  faq_6_q: { en: "Can I cancel at any time?", nl: "Kan ik op elk moment opzeggen?" },
  faq_6_a: {
    en: "Yes. No lock-in. Cancel via /billing with one click and the AI immediately stops trading on your account. You keep access until the end of your paid period.",
    nl: "Ja. Geen lock-in. Cancel via /billing met één klik en de AI stopt direct met handelen op jouw account. Je houdt toegang tot het einde van je betaalperiode.",
  },
  faq_7_q: { en: "Is my broker login stored?", nl: "Wordt mijn broker login opgeslagen?" },
  faq_7_a: {
    en: "No. Login goes directly to MetaApi (cloud-G2 London, encrypted storage on their side). We only store your account-ID, not your credentials. If we got hacked, no one could touch your money.",
    nl: "Nee. Login wordt direct doorgestuurd naar MetaApi (cloud-G2 London, encrypted opslag aan hun kant). Wij bewaren alleen je account-ID, niet je credentials. Als wij gehackt zouden worden kan niemand bij je geld.",
  },
  faq_8_q: { en: "What if individual trades lose?", nl: "Wat als individuele trades verliezen?" },
  faq_8_a: {
    en: "That's exactly where risk management shines. Every trade has a pre-defined fixed-risk Stop-Loss — losses stay small. At TP2-hit, SL automatically moves to break-even, so from that point on a loss is impossible on that trade. The TP3 runner targets 10R. Math: 1 winner of 10R offsets 10 losers of 1R. That's why your account grows even when 50% of trades lose. A human can't maintain this discipline — an algorithm can.",
    nl: "Daar zit precies de kracht van risk management. Elke trade heeft een vooraf-gedefinieerde fixed-risk Stop-Loss — verliezen blijven klein. Bij TP2-hit verschuift SL automatisch naar break-even, dus vanaf dat punt is verlies onmogelijk op die trade. De TP3 runner pakt 10R targets. Math: 1 winner van 10R compenseert 10 losers van 1R. Daardoor groeit je account zelfs als 50% van de trades verliest. Een mens lukt deze discipline niet — een algoritme wel.",
  },
  faq_9_q: { en: "Am I still responsible for my own decisions?", nl: "Ben ik dan zelf nog verantwoordelijk?" },
  faq_9_a: {
    en: "Yes. TradingVisualizer is a tool, you are the trader. You stay in control: pause button in dashboard (all trades off instantly), cancel whenever you want, manual close in MT5 — always. Trading involves risk.",
    nl: "Ja. TradingVisualizer is een tool, jij bent de trader. Je houdt controle: pauzeknop in dashboard (alle trades direct uit), opzeggen wanneer je wil, handmatig sluiten in MT5 — altijd. Trading brengt risico's met zich mee.",
  },

  // ── FINAL CTA ─────────────────────────────────────────────────────────────
  final_title_1: { en: "Ready to trade",                  nl: "Klaar om hands-off" },
  final_title_2: { en: "hands-off?",                      nl: "te traden?" },
  final_sub: {
    en: "Test your AI free — 1 winning trade per week, no credit card. Upgrade only when convinced. Cancel anytime.",
    nl: "Test je AI gratis — 1 winnende trade per week, geen creditcard. Upgrade pas als je overtuigd bent. Cancel altijd.",
  },
  final_cta_free: { en: "🚀 Start free — 30s",         nl: "🚀 Start gratis — 30s" },
  final_cta_auto: { en: "⚡ Direct Hands-Off →",       nl: "⚡ Direct Hands-Off →" },
  final_trust: {
    en: "⏱️ Done in 30 seconds · No credit card · Cancel anytime",
    nl: "⏱️ Klaar in 30 seconden · Geen creditcard · Cancel wanneer je wil",
  },

  // ═════════════════════════════════════════════════════════════════════════
  // APP UI (logged-in pages — Header / Auth / Billing / Profile / Dashboard)
  // ═════════════════════════════════════════════════════════════════════════

  // ── HEADER (dashboard chrome) ─────────────────────────────────────────────
  header_live:        { en: "LIVE FEED",                nl: "LIVE FEED" },
  header_markets_sub: { en: "5 markets · 15M · ET",     nl: "5 markten · 15M · ET" },
  header_refresh:     { en: "Refresh",                  nl: "Refresh" },
  header_syncing:     { en: "Syncing...",               nl: "Syncing..." },
  header_logout:      { en: "Log out",                  nl: "Uitloggen" },
  header_profile:     { en: "My profile",               nl: "Mijn profiel" },

  bell_title:         { en: "Notifications",            nl: "Notificaties" },
  bell_all_link:      { en: "All invoices →",           nl: "Alle facturen →" },
  bell_locked:        { en: "🔒 Trading paused — open invoice", nl: "🔒 Trading gepauzeerd — open factuur" },
  bell_empty:         { en: "No outstanding invoices ✓", nl: "Geen openstaande facturen ✓" },
  bell_subscription:  { en: "Auto-Trade subscription",   nl: "Auto-Trade abonnement" },
  bell_perf_fee:      { en: "Performance fee 10%",       nl: "Performance fee 10%" },
  bell_pay_now:       { en: "Pay now →",                 nl: "Betaal nu →" },

  // ── AUTH PAGE ─────────────────────────────────────────────────────────────
  auth_back:          { en: "← TradingVisualizer",      nl: "← TradingVisualizer" },
  auth_login_title:   { en: "Welcome back",             nl: "Welkom terug" },
  auth_login_sub:     { en: "Log in to view your AI assistant", nl: "Log in om je AI-assistent te bekijken" },
  auth_reg_title_free: { en: "Hire your AI free",       nl: "Hire je AI gratis" },
  auth_reg_title_signal: { en: "Start AI-Analyst",      nl: "Start AI-Analist" },
  auth_reg_title_auto: { en: "Start Hands-Off AI",      nl: "Start Hands-Off AI" },
  auth_reg_sub_free:  { en: "Test your AI assistant — 1 winning trade per week. No credit card.", nl: "Test je AI-assistent — 1 winnende analyse per week. Geen creditcard." },
  auth_reg_sub_signal: { en: "Unlimited analyses, you execute. €39/mo.", nl: "Onbeperkt analyses, jij voert zelf uit. €39/mnd." },
  auth_reg_sub_auto:  { en: "Fully hands-off — AI executes on your broker. €69/mo.", nl: "Volledig hands-off — AI doet alles op je broker. €69/mnd." },
  auth_tab_login:     { en: "Log in",                   nl: "Inloggen" },
  auth_tab_register:  { en: "Register",                 nl: "Registreren" },
  auth_label_name:    { en: "Name",                     nl: "Naam" },
  auth_optional:      { en: "(optional)",               nl: "(optioneel)" },
  auth_placeholder_name: { en: "What your AI may call you", nl: "Hoe je AI je mag aanspreken" },
  auth_label_email:   { en: "Email",                    nl: "E-mailadres" },
  auth_placeholder_email: { en: "name@email.com",       nl: "naam@email.com" },
  auth_label_pwd:     { en: "Password",                 nl: "Wachtwoord" },
  auth_placeholder_pwd_reg: { en: "Minimum 8 characters", nl: "Minimaal 8 tekens" },
  auth_placeholder_pwd_login: { en: "Your password",    nl: "Jouw wachtwoord" },
  auth_choose_role:   { en: "Choose your AI's role",    nl: "Welke AI-rol kies je?" },
  auth_tier_free_name: { en: "Test free",               nl: "Test gratis" },
  auth_tier_free_desc: { en: "1 winning analysis/week. Try it out.", nl: "1 winnende analyse/week. Probeer 'm uit." },
  auth_tier_signal_name: { en: "AI-Analyst",            nl: "AI-Analist" },
  auth_tier_signal_desc: { en: "Unlimited analyses. You execute.", nl: "Onbeperkt analyses. Jij voert uit." },
  auth_tier_auto_name: { en: "Hands-Off AI",            nl: "Hands-Off AI" },
  auth_tier_auto_desc: { en: "AI does everything. Including execution.", nl: "AI doet alles. Inclusief uitvoering." },
  auth_confirm_signal: { en: "AI-Analyst · €39/mo",     nl: "AI-Analist · €39/mnd" },
  auth_confirm_auto:  { en: "Hands-Off AI · €69/mo",    nl: "Hands-Off AI · €69/mnd" },
  auth_confirm_after: { en: "After registration → Stripe Checkout", nl: "Na registratie → Stripe Checkout" },
  auth_switch_free:   { en: "Prefer to test free?",     nl: "Liever gratis testen?" },
  auth_submit_login:  { en: "Log in",                   nl: "Inloggen" },
  auth_submit_free:   { en: "🚀 Start free →",          nl: "🚀 Start gratis →" },
  auth_submit_signal: { en: "Start AI-Analyst · €39/mo →", nl: "Start AI-Analist · €39/mnd →" },
  auth_submit_auto:   { en: "Hire Hands-Off AI · €69/mo →", nl: "Hire Hands-Off AI · €69/mnd →" },
  auth_trust_free:    { en: "⏱️ 30 seconds · No credit card needed", nl: "⏱️ 30 seconden · Geen creditcard nodig" },
  auth_trust_paid:    { en: "⏱️ 30 seconds · Secure payment via Stripe", nl: "⏱️ 30 seconden · Veilige betaling via Stripe" },
  auth_switch_to_register: { en: "No account yet?",     nl: "Nog geen account?" },
  auth_switch_to_login: { en: "Already have an account?", nl: "Al een account?" },
  auth_link_register:  { en: "Register",                nl: "Registreren" },
  auth_link_login:     { en: "Log in",                  nl: "Inloggen" },
  auth_err_fields:     { en: "Please fill in all fields", nl: "Vul alle velden in" },
  auth_err_network:    { en: "Network error, please try again", nl: "Netwerkfout, probeer opnieuw" },

  // ── BILLING PAGE ──────────────────────────────────────────────────────────
  bill_title:         { en: "Billing & Subscription",   nl: "Facturatie & Abonnement" },
  bill_back:          { en: "← Dashboard",              nl: "← Dashboard" },
  bill_loading:       { en: "Loading…",                 nl: "Laden…" },
  bill_banner_success: { en: "✓ Subscription activated. Welcome!", nl: "✓ Abonnement geactiveerd. Welkom!" },
  bill_banner_canceled: { en: "Checkout canceled — no changes.", nl: "Checkout geannuleerd — geen wijzigingen." },
  bill_current_tier:  { en: "Current tier",             nl: "Huidige tier" },
  bill_tier_free:     { en: "Free",                     nl: "Gratis" },
  bill_tier_signal:   { en: "AI-Analyst",               nl: "AI-Analist" },
  bill_tier_auto:     { en: "Hands-Off AI",             nl: "Hands-Off AI" },
  bill_tier_free_desc: { en: "1 winning trade per week (until first TP2)", nl: "1 winnend signaal per week (tot eerste TP2)" },
  bill_tier_signal_desc: { en: "Unlimited real-time signals — manual trading", nl: "Onbeperkt real-time signals — manual trading" },
  bill_tier_auto_desc: { en: "Signals + autonomous trading via Liquid Markets", nl: "Signals + autonomous trading via Liquid Markets" },
  bill_status_active:   { en: "Active",                 nl: "Actief" },
  bill_status_trialing: { en: "Trial period",           nl: "Proefperiode" },
  bill_status_past_due: { en: "Past due",               nl: "Achterstallig" },
  bill_status_canceled: { en: "Canceled",               nl: "Geannuleerd" },
  bill_until:         { en: "Active until:",            nl: "Lopende periode tot:" },
  bill_trial_until:   { en: "Free until:",              nl: "Gratis tot:" },
  bill_locked_title:  { en: "🔒 Trading paused",        nl: "🔒 Trading gepauzeerd" },
  bill_locked_body:   { en: "You have {n} outstanding invoice(s). Pay below to reactivate Auto-Trade.", nl: "Er zijn {n} openstaande factuur/facturen. Betaal hieronder om Auto-Trade weer te activeren." },
  bill_btn_signal:    { en: "AI-Analyst — €39/mo",      nl: "AI-Analist — €39/mnd" },
  bill_btn_auto:      { en: "Auto-Trade — €69/mo",      nl: "Auto-Trade — €69/mnd" },
  bill_btn_upgrade_auto: { en: "Upgrade to Auto-Trade — €69/mo", nl: "Upgrade naar Auto-Trade — €69/mnd" },
  bill_btn_manage:    { en: "Manage subscription",      nl: "Beheer abonnement" },
  bill_admin_note:    { en: "⭐ Admin — all services free, no invoices.", nl: "⭐ Admin — alle services gratis, geen facturen." },
  bill_invoices_title: { en: "Invoices",                nl: "Facturen" },
  bill_invoices_empty: { en: "No invoices — nothing to pay.", nl: "Geen facturen — nog niets om te betalen." },
  bill_inv_date:      { en: "Date",                     nl: "Datum" },
  bill_inv_type:      { en: "Type",                     nl: "Type" },
  bill_inv_period:    { en: "Period",                   nl: "Periode" },
  bill_inv_amount:    { en: "Amount",                   nl: "Bedrag" },
  bill_inv_status:    { en: "Status",                   nl: "Status" },
  bill_inv_subscription: { en: "Subscription",          nl: "Abonnement" },
  bill_inv_perf_fee:  { en: "Performance fee (10%)",    nl: "Performance fee (10%)" },
  bill_inv_open:      { en: "Open",                     nl: "Open" },
  bill_inv_paid:      { en: "Paid",                     nl: "Betaald" },
  bill_inv_paid_on:   { en: "on",                       nl: "op" },
  bill_inv_pay_now:   { en: "Pay now",                  nl: "Betaal nu" },

  // ── PROFILE PAGE ──────────────────────────────────────────────────────────
  prof_title:         { en: "My Profile",               nl: "Mijn Profiel" },
  prof_member_since:  { en: "Member since",             nl: "Lid sinds" },
  prof_last_login:    { en: "last login",               nl: "laatst ingelogd" },
  prof_admin_badge:   { en: "⭐ ADMIN",                  nl: "⭐ ADMIN" },
  prof_lock_title:    { en: "🔒 Account locked",        nl: "🔒 Account vergrendeld" },
  prof_lock_body:     { en: "You have {n} outstanding invoice(s). Pay to reactivate Auto-Trade.", nl: "Je hebt {n} openstaande factu(u)r(en). Betaal om Auto-Trade weer te activeren." },
  prof_lock_link:     { en: "View invoices →",          nl: "Bekijk facturen →" },
  prof_subscription:  { en: "Subscription",             nl: "Abonnement" },
  prof_plan:          { en: "Plan",                     nl: "Plan" },
  prof_status:        { en: "Status",                   nl: "Status" },
  prof_renews:        { en: "Renews on",                nl: "Verlengt op" },
  prof_trial_until:   { en: "Free until",               nl: "Gratis tot" },
  prof_broker_accs:   { en: "Broker accounts",          nl: "Broker accounts" },
  prof_connected:     { en: "connected",                nl: "gekoppeld" },
  prof_addon_extras:  { en: "({n}× €19 add-on)",        nl: "({n}× €19 add-on)" },
  prof_monthly:       { en: "Monthly amount",           nl: "Maandbedrag" },
  prof_btn_view_plans: { en: "View plans & upgrade →",  nl: "Bekijk plannen & upgrade →" },
  prof_btn_manage:    { en: "Manage subscription",      nl: "Beheer abonnement" },
  prof_weekly_title:  { en: "📅 Free weekly signal",    nl: "📅 Gratis week-signaal" },
  prof_weekly_done:   { en: "Free signal of this week delivered", nl: "Gratis signaal van deze week is geleverd" },
  prof_weekly_reset:  { en: "Reset on",                 nl: "Reset op" },
  prof_weekly_next_monday: { en: "(next Monday)",       nl: "(volgende maandag)" },
  prof_winning_was:   { en: "The winning signal:",      nl: "Het winnende signaal:" },
  prof_market:        { en: "Market",                   nl: "Markt" },
  prof_direction:     { en: "Direction",                nl: "Richting" },
  prof_entry:         { en: "Entry",                    nl: "Entry" },
  prof_tp2_hit:       { en: "TP2 hit",                  nl: "TP2 hit" },
  prof_entry_at:      { en: "Entry @",                  nl: "Entry @" },
  prof_tf:            { en: "TF",                       nl: "TF" },
  prof_weekly_active_title: { en: "Your free weekly signal is still available", nl: "Je gratis week-signaal is nog beschikbaar" },
  prof_weekly_active_body: { en: "You see all live signals until the first TP2-hit of this week. Then locked until {date}.", nl: "Je ziet alle live signalen tot het eerste TP2 van deze week wordt gehit. Daarna lock tot {date}." },
  prof_upgrade_head:  { en: "Want more signals?",       nl: "Wil je meer signalen?" },
  prof_upgrade_explain: {
    en: "Both plans give you unlimited live signals — all markets, all TFs (6H / 90M / Daily), via dashboard and Discord. The difference is WHO executes the trade:",
    nl: "Bij beide plannen krijg je onbeperkt live signalen — alle markten, alle TFs (6H / 90M / Daily), direct via dashboard én Discord. Het verschil zit in WIE de trade uitvoert:",
  },
  prof_signal_for:    { en: "For traders who execute themselves", nl: "Voor wie ZELF wil traden" },
  prof_signal_li1:    { en: "✅ Unlimited live signals",           nl: "✅ Onbeperkt live signals" },
  prof_signal_li2:    { en: "✅ Discord notifications",            nl: "✅ Discord notificaties" },
  prof_signal_li3:    { en: "✅ All TFs + markets",                nl: "✅ Alle TFs + markten" },
  prof_signal_li4:    { en: "👤 YOU open the trade on your broker", nl: "👤 JIJ opent zelf de trade op je broker" },
  prof_signal_li5:    { en: "❌ No automatic execution",           nl: "❌ Geen automatische uitvoering" },
  prof_signal_li6:    { en: "❌ No broker integration",            nl: "❌ Geen broker-koppeling" },
  prof_signal_best:   { en: "💡 Best for: experienced traders who want control over entry-timing and lot-size.", nl: "💡 Best voor: ervaren traders die controle willen over entry-timing en lot-size." },
  prof_signal_btn:    { en: "Choose AI-Analyst →",                nl: "Kies AI-Analist →" },
  prof_auto_for:      { en: "For hands-off earners",              nl: "Voor wie HANDS-OFF wil verdienen" },
  prof_auto_li1:      { en: "✅ Everything from AI-Analyst",       nl: "✅ Alles van AI-Analist" },
  prof_auto_li2:      { en: "🤖 AI opens trade automatically on your broker", nl: "🤖 AI opent trade automatisch op jouw broker" },
  prof_auto_li3:      { en: "🛡️ Auto Stop-Loss + Take-Profit management", nl: "🛡️ Auto Stop-Loss + Take-Profit beheer" },
  prof_auto_li4:      { en: "🚀 BE-MOVE: SL to break-even after TP2 (no loss possible)", nl: "🚀 BE-MOVE: SL naar break-even na TP2 (geen verlies meer mogelijk)" },
  prof_auto_li5:      { en: "📊 Performance dashboard with balance graph", nl: "📊 Performance dashboard met balance grafiek" },
  prof_auto_li6:      { en: "🔌 Liquid Markets MT5 integration (required broker)", nl: "🔌 Liquid Markets MT5 koppeling (verplichte broker)" },
  prof_auto_perf:     { en: "+ 10% performance fee on profit (high-water mark)", nl: "+ 10% performance fee op winst (high-water mark)" },
  prof_auto_best:     { en: "💡 Best for: passive traders, busy schedule, or beginners who want to learn by watching execution.", nl: "💡 Best voor: passieve traders, drukke schedule, of beginners die de strategie willen leren door uitvoering te zien." },
  prof_auto_btn:      { en: "Choose Auto-Trade →",                nl: "Kies Auto-Trade →" },
  prof_faq_q1:        { en: "What is Auto-Trade exactly?",        nl: "Wat is \"Auto-Trade\" precies?" },
  prof_faq_a1:        {
    en: "You connect your Liquid Markets MT5 broker account once via a secure form (your login goes directly to MetaApi, we don't store it). From that moment, our system automatically opens every setup-trade as soon as it hits its entry-window. Stop-Loss + Take-Profit are sent to the broker. At TP2-hit, Stop-Loss automatically moves to break-even — from that point you can't lose anything on that trade. Runner runs to TP3 or SL@BE. You stay in full control: pause-button in dashboard, cancel anytime, and you can always close manually in MetaTrader.",
    nl: "Je koppelt eenmalig je Liquid Markets MT5 broker-account via een veilig formulier (jouw login wordt direct doorgestuurd naar MetaApi, wij slaan 'm niet op). Vanaf dat moment opent ons systeem automatisch elke setup-trade zodra die zijn entry-window haalt. Stop-Loss + Take-Profit worden meegestuurd naar de broker. Bij TP2-hit wordt de Stop-Loss automatisch verschoven naar break-even — vanaf dat punt kan je geen verlies meer maken op die trade. De runner blijft lopen tot TP3 of SL@BE. Je hebt volledige controle: pauzeer-knop in het dashboard, opzeggen wanneer je wil, en je kan altijd zelf handmatig sluiten in MetaTrader.",
  },
  prof_faq_q2:        { en: "What's the 10% performance fee?",    nl: "Wat is de 10% performance fee?" },
  prof_faq_a2:        {
    en: "Auto-Trade only. 10% of your net profit per calendar month, invoiced on the 1st of the next month. With high-water mark: you only pay on new highs, never double on recovery.",
    nl: "Alleen op Auto-Trade. 10% van je netto-winst per kalendermaand, gefactureerd op de 1e van de volgende maand. Met high-water mark: je betaalt alleen op nieuwe hoogtepunten, nooit dubbel op recovery.",
  },
  prof_faq_q3:        { en: "What if I want to upgrade or downgrade?", nl: "Wat als ik wil upgraden of downgraden?" },
  prof_faq_a3:        {
    en: "On /billing you can cancel your subscription anytime (no lock-in) or switch between AI-Analyst (€39) and Auto-Trade (€69). Pro-rata calculation via Stripe.",
    nl: "Op /billing kan je je abonnement op elk moment opzeggen (geen lock-in) of switchen tussen AI-Analist (€39) en Auto-Trade (€69). Pro-rata berekening via Stripe.",
  },
  prof_access_title:  { en: "Signal access",            nl: "Signaal-toegang" },
  prof_access_full:   { en: "Full access",              nl: "Volledige toegang" },
  prof_access_full_desc: { en: "All signals real-time, all TFs, all markets.", nl: "Alle signalen real-time, alle TFs, alle markten." },
  prof_access_freew:  { en: "Free week — active",       nl: "Gratis week — actief" },
  prof_access_freew_desc: { en: "Live signals until the first TP2 of the week.", nl: "Live signalen tot eerste TP2 van de week." },
  prof_access_locked: { en: "Week ended — no signals until {date}", nl: "Week voorbij — geen signalen tot {date}" },
  prof_access_locked_desc: { en: "Upgrade to Auto-Trade for unlimited real-time access.", nl: "Upgrade naar Auto-Trade voor onbeperkte real-time toegang." },
  prof_quick_actions: { en: "Quick actions",            nl: "Snelle acties" },
  prof_link_billing:  { en: "Invoices & subscription",  nl: "Facturen & abonnement" },
  prof_link_broker:   { en: "Broker connection",        nl: "Broker koppeling" },
  prof_link_journal:  { en: "Trade journal",            nl: "Trade journal" },
  prof_link_admin:    { en: "Admin panel",              nl: "Admin panel" },

  // ── DASHBOARD — free-tier lock card ───────────────────────────────────────
  fl_title:           { en: "Free weekly signal delivered ✓", nl: "Gratis week-signaal geleverd ✓" },
  fl_your_signal:     { en: "🎯 Your free signal:",     nl: "🎯 Jouw gratis signaal:" },
  fl_tp2_at:          { en: "— TP2 hit @",              nl: "— TP2 hit @" },
  fl_missed:          { en: "{n} winning {trades} MISSED", nl: "{n} winnende {trades} GEMIST" },
  fl_missed_singular: { en: "trade",                    nl: "trade" },
  fl_missed_plural:   { en: "trades",                   nl: "trades" },
  fl_missed_tag:      { en: "this week",                nl: "deze week" },
  fl_missed_sub:      { en: "Auto-Trade users caught these automatically:", nl: "Auto-Trade users hebben deze trades wel automatisch gepakt:" },
  fl_more:            { en: "+ {n} more…",              nl: "+ {n} meer…" },
  fl_next_signal:     { en: "Next free signal available on", nl: "Volgende gratis signaal beschikbaar op" },
  fl_cta_question:    { en: "Want to see every trade live and run it on autopilot?", nl: "Wil je elke trade live zien en autonomous laten draaien?" },
  fl_cta_signal:      { en: "AI-Analyst — €39/mo",      nl: "AI-Analist — €39/mnd" },
  fl_cta_auto:        { en: "Auto-Trade — €69/mo →",    nl: "Auto-Trade — €69/mnd →" },

  // ── FOOTER ────────────────────────────────────────────────────────────────
  footer_tag: {
    en: "AI Trading Assistant — works for you.",
    nl: "AI Trading Assistant — werkt voor jou.",
  },
  footer_legal: {
    en: "© 2026 TradingVisualizer · TradingVisualizer is a SaaS-tool for self-directed traders. We don't provide investment advice and are not a wealth manager. Trading involves risk. Past performance is not a guarantee of future results. You remain fully responsible for your own trading decisions and account.",
    nl: "© 2026 TradingVisualizer · TradingVisualizer is een SaaS-tool voor self-directed traders. Wij geven geen beleggingsadvies en zijn geen vermogensbeheerder. Trading brengt risico's met zich mee. Verleden prestaties zijn geen garantie voor toekomstige resultaten. Jij blijft volledig verantwoordelijk voor je eigen trading-beslissingen en account.",
  },
};

// Get translation for a key. Falls back to EN if NL missing, then to the key itself.
// Supports {placeholder} interpolation: t("hero_badge", { markets: 7 })
export function tStr(key, lang = "en", vars = {}) {
  const entry = TRANSLATIONS[key];
  if (!entry) return key;            // missing — show key for debug
  let str = entry[lang] ?? entry.en ?? key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replaceAll(`{${k}}`, String(v));
  }
  return str;
}
