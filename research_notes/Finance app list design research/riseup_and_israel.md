# RiseUp and Israeli bank / card / payment apps: transaction lists, monthly spending views, and user sentiment (2025–2026)

Research date: 2026-11-09. Primary sources are RiseUp's own help centre (intercom.riseup.co.il, most articles stamped "30 בספטמבר 2026"), riseup.co.il marketing/FAQ pages, Israeli App Store listings (Max, Cal, Isracard, RiseUp), Israeli press (Geektime, Globes, TheMarker/Supermarker, ice) and the הסולידית (HaSolidit) forum. Competitor blogs (Lyra, Moneytor) are flagged as such. Hebrew terms are given verbatim with translation in parentheses.

---

## Key Question 1 — RiseUp: structure of the monthly view, grouping, categories, fixed / tracked / variable, installments, P2P, refunds, savings, transaction row, "left to spend", pricing, reviews

### Takeaway
RiseUp's single central screen is the "תזרים" (tazrim, "cashflow") for one month: it is not a transaction browser but a forecast built from five stacked blocks — הוצאות משתנות (variable expenses, split by week), קטגוריות במעקב (tracked categories, blue), הפקדות לחיסכון (savings deposits, orange), הוצאות קבועות (fixed expenses), הכנסות (income) — with a grey "לא בתזרים" (not in cashflow) bucket at the bottom. Every expense is placed on the day the purchase was made, regardless of the card's billing date, and the headline number is a single green figure: how much is left to spend on variable expenses this week. Pricing is 55 ₪/month (44 ₪/month annual) after a 35-day trial; the iOS app is rated 4.3 (134 ratings) with complaints centring on lag, no English, price-vs-value and no manual/cash entry.

### Cited Findings

**Top-level sections and vertical order of the תזרים**
- The official "how the cashflow is calculated" guide walks the screen from the bottom up: "כדי להבין את החישוב של התזרים צריך להתחיל מלמטה, מהחלק של ההכנסות" (start from the bottom, the income part), then "נגלול למעלה ונגיע להוצאות הקבועות" (scroll up to fixed expenses), then "החלק שבצבע כתום ״הפקדות לחיסכון״" (the orange "savings deposits" part), then "קטגוריות במעקב" (tracked categories), then variable expenses at the top. Worked example: 15,000 ₪ fixed income − 5,000 ₪ fixed expenses − 1,000 ₪ savings − 2,500 ₪ tracked categories (סופר 1,500, רכב 500, אוכל בחוץ 750, פארמה 250) = 6,500 ₪ for variable expenses; a 2,500 ₪ "יעד חודשי" (monthly target) then leaves 4,000 ₪, i.e. 1,000 ₪ per week in a 4-week month — [איך התזרים מחושב?](https://intercom.riseup.co.il/he/articles/8890719)
- Below income sits a part "שמציג את כל ההוצאות וההכנסות שלא משפיעות על החישוב של התזרים" (all expenses/income that do not affect the calculation) plus a total of how much actually went out this month across all categories — [איך התזרים מחושב?](https://intercom.riseup.co.il/he/articles/8890719)
- The "not in cashflow" bucket is "בחלק התחתון שבתזרים, זה שבצבע אפור ״לא בתזרים״" (the grey bottom part), expandable via "פירוט" (details) — [מה נחשב ״לא בתזרים״?](https://intercom.riseup.co.il/he/articles/8995719)
- Tracked categories are the blue ones: "הקטגוריות במעקב (אלו שבצבע כחול בתזרים)" — [איך להשתמש בתוכניות הגדולות בתזרים?](https://intercom.riseup.co.il/he/articles/8078071)
- Section names as used in the setup guide: "הכנסות הקבועות", "הכנסות המשתנות", "הוצאות קבועות", "קטגוריות במעקב", "הוצאות משתנות", "תמונת מצב" (snapshot) — [איך לדייק את התזרים?](https://intercom.riseup.co.il/he/articles/6423214)
- Idan Ben-Or's review (affiliate-linked) lists the monthly view as הכנסות / הוצאות קבועות / הוצאות למעקב / הוצאות משתנות / חיסכון, and notes income shows "הסכום הצפוי לחודש ואת מה שכבר נכנס" (expected and already received), with a per-source breakdown on tap — [idanbenor.co.il](https://www.idanbenor.co.il/business-management/riseup-review/)

**The "how much is left to spend" presentation**
- "כדי לדעת כמה כסף נשאר להוציא על הוצאות משתנות בשבוע, נסתכל על המספר שבצבע ירוק בכניסה לתזרים" (the green number at the entrance to the cashflow); the month-level figure is labelled "מומלץ להוציא עד" (recommended to spend up to) in the variable-expenses block; each tracked category shows "נשאר להוציא" (left to spend) and, on overrun, the overrun amount, which reduces the variable-expense balance — [כמה כסף נשאר להוציא בכל קטגוריה?](https://intercom.riseup.co.il/he/articles/8976343)
- Negative cashflow: "המספר שמוצג הוא היתרה השלילית שנותרה, וכל הוצאה משתנה מגדילה אותה" (the number shown is the remaining negative balance; each variable expense increases it) — [איך לדייק את התזרים?](https://intercom.riseup.co.il/he/articles/6423214)
- A week is Sunday–Saturday; a week straddling two months is a short week; the monthly variable budget is divided by days in the month and multiplied by the days in that week (e.g. 3,100 ₪ over 31 days → 500 ₪ for a 5-day first week, 700 ₪ for a 7-day week) — [מה זה שבוע בתזרים?](https://intercom.riseup.co.il/he/articles/8995624)
- Variable expenses "מוצגות בחלוקה לשבועות" (shown split by week) and can carry notes — [איך לדייק את התזרים?](https://intercom.riseup.co.il/he/articles/6423214)
- Older (2020) Globes review already described the home screen as showing how much can still be spent this week/month, projected end-of-month balance, and recommended/expected spending per category, with grocery estimated from past card data — [Globes, 16.11.2020](https://www.globes.co.il/news/article.aspx?did=1001349477)

**Fixed vs tracked vs variable: definitions and rules**
- Fixed expense = "הוצאה שהתחייבנו אליה עוד לפני שהתחיל החודש, לכן היא תרד בוודאות" (committed before the month started, will certainly go out), e.g. car insurance; tracked category = expenses made several times a month at varying amounts/timing, e.g. fuel; the forecast for a tracked category is the user-set amount "או לפי ממוצע ההוצאות בשלושת החודשים הקודמים" (or the average of the previous three months) — [מה ההבדל בין קטגוריות במעקב להוצאות קבועות?](https://intercom.riseup.co.il/he/articles/8995626)
- Rule 1: an item is forecast as fixed only if it appeared last month and was defined as fixed; rule 2: every bank/card transaction is read, and anything not part of the month should be marked "לא תזרימיות" — [איך לדייק את התזרים?](https://intercom.riseup.co.il/he/articles/6423214)
- Fixed-expense examples in the help centre: "חשמל, משכנתא, מינויים והוצאות בתשלומים" (electricity, mortgage, subscriptions and expenses in installments); tracked-category examples: "אוכל בחוץ, הוצאות סופר, רכב, פארמה ותחבורה ציבורית" (eating out, supermarket, car, pharma, public transport); recommendation to keep ≤4 tracked categories — [מה לבדוק כשהתזרים שלילי?](https://intercom.riseup.co.il/he/articles/6228720)
- Adding a tracked category: scroll down, press "הוספת קטגוריה למעקב" under the blue categories, pick from a list or "אחר" (other) for a custom one, which is then added to previous months too; forecast editing via "עריכת סכום" / "עדכון הסכום הצפוי"; fixed items via "עריכת צפי" / "מחיקת צפי הוצאה"; a transaction is moved with "להזיז את ההוצאה" and marked fixed with "קבועה"; income reclassified via "זו לא הכנסה משתנה" → "קבועה" — [תחילת חודש ותזרים חדש](https://intercom.riseup.co.il/he/articles/8886728)
- Category names used on the marketing/help side: ביגוד והנעלה (clothing & footwear), אוכל בחוץ (eating out), סופר (supermarket), רכב (car), פארמה (pharma), תחבורה ציבורית, דלק (fuel) — [פילטר לפי חשבונות וכרטיסים](https://intercom.riseup.co.il/he/articles/10526005); [מה לבדוק כשהתזרים שלילי?](https://intercom.riseup.co.il/he/articles/6228720); [איך התזרים מחושב?](https://intercom.riseup.co.il/he/articles/8890719)
- Fixed expenses cannot be split ("הוצאות קבועות חוזרות כמו שהן מחודש לחודש… בחרנו לשמור על פשטות") and income cannot be split "כרגע" — [פיצול הוצאות בתזרים](https://intercom.riseup.co.il/he/articles/6608891)
- RiseUp's rule-of-thumb target: 50% fixed, 30% variable + tracked, 20% savings; review fixed expenses quarterly — [ההוצאות הקבועות תחת זכוכית מגדלת](https://intercom.riseup.co.il/he/articles/8612761)

**Card billing date vs purchase date; installments**
- "בתזרים כל ההוצאות יופיעו לפי התאריך שבו ביצעת את העסקה" (all expenses appear by the transaction date); a shirt bought 30.12 shows on 30.12 regardless of the 2nd/10th/15th billing date; the cashflow "לא נועד בשביל לעקוב אחרי מצב העו״ש" (is not meant to track the current-account balance) — [איך התזרים מתייחס לחיוב באשראי?](https://intercom.riseup.co.il/he/articles/8976556)
- The method "סופרת כל הוצאה כאילו היא מחויבת בבנק ביום שבו היא בוצעה (כמו בכרטיס חיוב מיידי - דיירקט/דביט)"; default month starts on the 1st, with an option "תזרים מה-10 לחודש" (10th–9th) because the 10th is Israel's most common card billing date; in the 10th-mode, fixed income received before the 10th is pulled into that month; a page "מצב העו״ש והאשראי" (current-account and credit status) shows actual balance and upcoming card charges — [האם תזרים מה-10 לחודש מתאים לי?](https://intercom.riseup.co.il/he/articles/8135407)
- Moving a transaction to a different month is only possible via the in-app chat bot ("להעביר הוצאה לחודש הקודם או הנוכחי"), which lists the 15 newest transactions; RiseUp recommends leaving expenses in the month they occurred — [להעביר עסקאות בין חודשים](https://intercom.riseup.co.il/he/articles/11081681)
- Competitor Lyra's comparison table marks RiseUp's per-card billing-cycle support as "חלקי" (partial) — [lyra-il.com (competitor)](https://lyra-il.com/blog/riseup-review)

**Bit / PayBox / person-to-person transfers and refunds**
- A gift "שנשלחה ב-Bit" is given as an example of a variable, unplannable expense — [idanbenor.co.il](https://www.idanbenor.co.il/business-management/riseup-review/)
- Paying for a friend and being repaid: "כדאי שההוצאה על החברה וגם ההכנסה של ההחזר ממנה יהיו מוגדרות כ״לא בתזרים״" (both the outlay and the refund should be marked not-in-cashflow) — [מה נחשב ״לא בתזרים״?](https://intercom.riseup.co.il/he/articles/8995719)
- Restaurant example: keep your own share in "אוכל בחוץ", mark the friend's share "לא בתזרים" and the friend's repayment as "הכנסה לא תזרימית" — [איך להשתמש בתזרים ביומיום?](https://intercom.riseup.co.il/he/articles/8995730)
- Splitting: tap an expense → "לפצל את ההוצאה"; default two parts "הוצאה 1" and "מה שנשאר" (what remains), unlimited parts, each assigned to variable / a tracked category / "לא תזרימית", with a note per part; "הוצאה מפוצלת תופיע עם הסכום של ההוצאה המקורית" (a split expense is listed at its original amount) — [פיצול הוצאות בתזרים](https://intercom.riseup.co.il/he/articles/6608891)
- Unrecognised charge guide lists dispute contacts for מקס, ישראכרט, ויזה כאל, אמריקן אקספרס and distinguishes "הכחשת עסקה" (chargeback) from "ביטול עסקה צרכנית" — [מה עושים במקרה שמצאתי עסקה שאני לא מזהה?](https://intercom.riseup.co.il/he/articles/6738408)

**Cash**
- "אין אפשרות להוסיף הוצאות והכנסות לתזרים באופן ידני" (no manual entry); an ATM withdrawal is an expense to be split with notes; a cash deposit appears under variable income — [מה לעשות עם מזומן בתזרים?](https://intercom.riseup.co.il/he/articles/8995937)

**Savings**
- "הפקדות לחיסכון" (savings deposits) is its own orange block, counted in the forecast — [איך התזרים מחושב?](https://intercom.riseup.co.il/he/articles/8890719)
- "יעד חודשי" (monthly target) is money set aside and excluded from the spendable amount; "תוכניות גדולות" (big plans, e.g. holiday, car, renovation) are opened via "מה אעשה עם הכסף" → "להוספת תוכניות גדולות", are not real deposits ("לא פיקדונות ממשיים"), and appear only for users whose current account has been positive for 3 consecutive months; plan pages show "כמה שמתי" and "על מה הוצאתי" — [איך להשתמש בתוכניות הגדולות בתזרים?](https://intercom.riseup.co.il/he/articles/8078071)
- "חיסכון דינמי" (dynamic savings): an algorithm "שפועל כל הזמן ברקע ומוצא לך הזדמנויות לחיסכון" and lets you open a savings product through the service — [riseup.co.il/questions](https://www.riseup.co.il/questions/)
- Help-centre savings collection has "חסכונות לטווח קצר" (5 articles) and "חיסכון לטווח ארוך - קופת גמל במיטב" (long-term: provident fund at Meitav) — [לתכנן את העתיד עם רייזאפ](https://intercom.riseup.co.il/he/collections/3548901)
- Financa (June 2025) says RiseUp partners with brokerage Meitav to propose a safe savings amount from 100 ₪ — [financa.co.il](https://financa.co.il/רייזאפ-ביקורת/)

**Transaction row and list interactions**
- Each item has a three-dot menu on its left ("שלוש הנקודות משמאל"); multi-select uses "העיגול שלצד כל הוצאה" (the circle beside each expense) via "להזיז כמה הוצאות ביחד", with destinations variable / tracked category / big plan / not-in-cashflow (not fixed or savings) — [העברת מספר הוצאות ביחד](https://intercom.riseup.co.il/he/articles/10430624)
- New transactions since last visit get "נקודה ירוקה" (a green dot) in the list and appear as cards in "הרייזאפ היומי" (the Daily RiseUp) at bottom-left — [דברים שכדאי לשים לב אליהם בתזרים](https://intercom.riseup.co.il/he/articles/9520903)
- A funnel icon top-right filters the cashflow by account/card, overlaying "שכבה נוספת בצבע כחול כהה" (a dark-blue layer) with the selected accounts' data — [פילטר לפי חשבונות וכרטיסים](https://intercom.riseup.co.il/he/articles/10526005)
- A search (🔍) exists per month to locate a transaction — [תחילת חודש ותזרים חדש](https://intercom.riseup.co.il/he/articles/8886728)
- Excel export exists ("איך לייצא את התזרים לאקסל?") — [תזרים למתקדמים](https://intercom.riseup.co.il/he/collections/8064289)
- RiseUp does not describe what fields a row shows beyond name, amount and date; Ben-Or notes the page "לא מתואר… מה כל שורת עסקה מכילה מלבד הסכום והתיאור" — [idanbenor.co.il](https://www.idanbenor.co.il/business-management/riseup-review/)

**Check-ins, alerts, insights**
- Recommendation to open the cashflow "לפחות שלוש פעמים בשבוע"; a WhatsApp follow-up message on Sundays; push reminders configurable up to 7 days a week — [איך להשתמש בתזרים ביומיום?](https://intercom.riseup.co.il/he/articles/8995730)
- Ben-Or and Financa report WhatsApp messages three times a week (Sun/Tue/Thu) with the weekly remaining amount and a link — [idanbenor.co.il](https://www.idanbenor.co.il/business-management/riseup-review/); [financa.co.il](https://financa.co.il/רייזאפ-ביקורת/)
- Insight examples: "הוצאה שהסכום שלה עלה, הוראת קבע שייתכן שנשכחה… או כמה כסף כדאי להפקיד לחיסכון" (an expense whose amount rose, a possibly forgotten standing order, how much to save) — [למי מתאימה השיטה של רייזאפ?](https://intercom.riseup.co.il/he/articles/8999519)
- Subscription page feature list: "לדעת בכל רגע כמה כסף נשאר", "להתעדכן בזמן אמת על כל חריגה בהוצאות", "להציב יעד חודשי ריאלי לחיסכון", "לצפות בסיכום והשוואה בין חודשים שונים", "לדעת ולשתף בדיוק כמה יצא החודש" — [riseup.co.il/subscription](https://www.riseup.co.il/subscription/)
- Financa names an AI "ניטור מגמות" (trend monitoring) and "הוצאות צפויות" (expected expenses) forecast — [financa.co.il](https://financa.co.il/רייזאפ-ביקורת/)
- Grocery vouchers ("תווי קניה לסופר") for Carrefour, Rami Levy, Victory and HaChishuk are offered inside the service — [תווי קניה לסופר](https://intercom.riseup.co.il/he/collections/11056581)

**Platform, connectivity, scope**
- "יש אפליקציה? כן!" on App Store and Google Play, plus browser; all banks except Bank Yerushalayim; not for business cashflow; open-banking read-only access; licensed by the Israel Securities Authority; data deleted within 48 hours on leaving — [riseup.co.il/questions](https://www.riseup.co.il/questions/)
- Ben-Or (older) said there was no app yet; Financa (June 2025) says Android/iOS apps "recently launched" and that earlier lack of push/fingerprint was a drawback — [idanbenor.co.il](https://www.idanbenor.co.il/business-management/riseup-review/); [financa.co.il](https://financa.co.il/רייזאפ-ביקורת/)
- iOS app id 6739494831 shows versions through 2025 (e.g. 1.28.10 on 13 Oct) — [App Store](https://apps.apple.com/il/app/riseup-רייזאפ/id6739494831)

**Pricing**
- Official: "מינוי חודשי + חודש ניסיון חינם 55 ₪ לחודש"; "מינוי שנתי… 44 ₪ לחודש סה״כ 528 ₪"; 35-day full-access trial; partner and children can be added free — [riseup.co.il](https://www.riseup.co.il/); [riseup.co.il/subscription](https://www.riseup.co.il/subscription/)
- Financa quotes 529 ₪/year vs 660 (community discount, auto-renews, no installments) and an affiliate 50%-off for two months — [financa.co.il](https://financa.co.il/רייזאפ-ביקורת/) (slight conflict with the 528 ₪ on riseup.co.il)
- Historical: 45 ₪/month in 2020 and in April 2024 — [Globes 2020](https://www.globes.co.il/news/article.aspx?did=1001349477); [ice, 30.4.2024](https://www.ice.co.il/positions/news/article/1010708)
- Marketing claim: customers' monthly saving "זינק ב-₪1,625 תוך 3 חודשים בממוצע" — [riseup.co.il/subscription](https://www.riseup.co.il/subscription/) (self-reported)

**Company context**
- ~50% of ~100 staff laid off April 2024, attributed to the war's impact on an Israel-centric customer base; "עשרות אלפי לקוחות"; UK expansion — [ice citing TheMarker](https://www.ice.co.il/positions/news/article/1010708)
- $30M Series B, >$50M total raised — [CTech](https://www.calcalistech.com/ctechnews/article/s19n1kmv5)
- Sensor Tower Q4 2025: weekly downloads 819→1.5K across the quarter, weekly revenue peaking $1.1K mid-quarter and $0.4K by late December — [Sensor Tower](https://sensortower.com/blog/2025-q4-unified-top-5-personal-finance-budgeting-and-planning-units-il-63e363f0e1714cfff1979caa)

**App Store reviews (Israel, iOS, 4.3★ / 134 ratings)**
- Seven of ten visible reviews ask for English ("Need English", "No English support", etc.); "Lags": "Slow slow slow… lags all the time"; Hebrew review "שימושי מאוד אבל יש עניינים קטנים" praises the order it brings but reports freezes and unresponsive scrolling; "אפליקציה מאוד מוגבלת ומאוד יקרה" says price does not match value and there is no manual/cash entry or basic editing; a Gmail sign-in loop — [App Store reviews](https://apps.apple.com/il/app/riseup-רייזאפ/id6739494831?see-all=reviews&platform=iphone)
- Smart Money People (UK product, letsriseup.com): 10 reviews, 4.4/5 — [smartmoneypeople](https://smartmoneypeople.com/RiseUp-reviews/product/RiseUp-app-reviews); a Trustpilot review of the UK product calls the UX "extremely clunky" and cancellation hard — [Trustpilot](https://www.trustpilot.com/review/letsriseup.com) (UK product, not the Israeli app)

### Inferences
- The vertical order (variable → tracked → savings → fixed → income → not-in-cashflow) and the colour code (green headline, blue tracked, orange savings, grey excluded) are consistent across several help articles, so this is RiseUp's current layout as of late 2026.
- RiseUp deliberately collapses the card-billing-cycle problem by booking everything on purchase date and offering a 10th–9th month as the only concession; it does not try to reconcile to the bank balance.
- Installments are handled implicitly: a monthly installment debit becomes a "fixed expense" by recurrence; there is no evidence of "תשלום 2/6" style display.
- P2P transfers (Bit/PayBox) are not auto-detected as transfers; the user is expected to split and mark them "לא בתזרים" manually.
- The English-language demand in reviews likely reflects olim/immigrant users; the lag complaints coincide with the 2025 native-app launch.

### Gaps
- No RiseUp help article specifically on installments ("תשלומים") or on Bit/PayBox detection was found; exact installment rendering unknown.
- Google Play listing/reviews for RiseUp could not be located via search (package name unknown).
- No screenshots were obtainable; exact row fields (merchant logo? card indicator? category chip?) unconfirmed.
- riseup.co.il/questions and /subscription blocked WebFetch (403) but were readable via curl; the Intercom article dates ("30 בספטמבר 2026") appear to be last-edit dates.

---

## Key Question 2 — Israeli card apps (Max, Isracard, Cal): billing cycle vs purchase date, installments, category breakdowns, UX criticism

### Takeaway
All three card apps organise the transaction list around the billing cycle ("מועד חיוב"), not the purchase month, and lead with "החיוב הקרוב" (the upcoming charge). Isracard (10.0.0, Oct 2025) and Cal expose category/sector breakdowns ("ענפים", "גרף הוצאות חודשי"); Max's store listing emphasises per-card upcoming charge, search, custom transaction tags and installment splitting, with no category breakdown described. Users rate Max 4.6 (63k), Cal 4.6 (72k), Isracard 4.2 (37k); criticisms include Hebrew-only UI, pop-ups, outdated UI, and (Isracard, 2023) poor separation of approved vs pending totals.

### Cited Findings

**Isracard**
- Description phrases: "פירוט עסקאות עדכני ומלא" per card; "התפלגות הוצאות לפי ענפים" (breakdown by sector) across all cards and "פילוח הוצאות לפי קטגוריות וענפים" per card; "סכום החיוב הקרוב ותאריך החיוב של הכרטיס"; "פריסת החיוב החודשי" (spreading the monthly charge) — [App Store](https://apps.apple.com/il/app/isracard-ישראכרט/id489783331)
- Version history: 9.0.46 (25 Dec 2024) added a countdown to the billing date, a total of approved-but-not-yet-processed transactions and a marker for the last installment payment; 9.0.59 (1 Feb 2025) reorganised transactions by billing date into current cycle / non-current / future-dated, tagging foreign transactions and highlighting discounts; 9.0.6x (2025) added a six-month spending chart and a "last 5 transactions across all cards" view; 10.0.0 (25 Oct 2025) new home screen with overview of all cards, quick-actions button and a new "חו"ל" (abroad) category; rating 4.2 from 37k, #1 Finance — [App Store](https://apps.apple.com/il/app/isracard-ישראכרט/id489783331)
- Isracard's magazine says transactions are "מחולקות לקטגוריות לפי מועד חיוב, מהחדשה לישנה" (divided into categories by billing date, newest to oldest) — [Isracard magazine](https://digital.isracard.co.il/Magazine/articles/iaracard-app/) (search snippet; page sits behind a cookie wall)
- Review (Ananda_Shake, Oct 2023): app "inferior to MAX"; auto-logout lands on main screen not login; approved total not clearly separated from "awaiting approval"; no widgets; no monthly category breakdown (since addressed) — [App Store](https://apps.apple.com/il/app/isracard-ישראכרט/id489783331)
- Another listing-level review complains the app lacks "אינטיליגנציה ותובנה מעל שכבת נתוני ההוצאות הגולמית המוצגת כרשימה וניתנת להורדה כקובץ PDF" (intelligence over the raw list, downloadable as PDF) — [mwm.ai aggregator](https://mwm.ai/apps/isracard/489783331)

**Max**
- Description: "החיובים שצריכים לרדת" (the charges due) viewable for all cards or per card; search for a specific transaction; tag transactions with custom names; "לחלק לתשלומים את סך החיוב החודשי" (split the monthly total into installments), also per transaction after the fact; no category breakdown or budget is described (only a travel "ניהול התקציב"); rating 4.6 from 63k — [App Store](https://apps.apple.com/il/app/מקס-max/id398915363)
- 2025 release notes: redesigned "פעולות" (Actions) tab — pick the action first, then the card (20.70.1, 30/03/2025; 20.71.1, 01/07/2025); larger fonts in charge details (20.53.x, Feb 2025); repeated installment-split improvements (20.85–20.90); "MAX Account" tab for savings/FX/investments — [App Store](https://apps.apple.com/il/app/מקס-max/id398915363)
- Reviews: "probably the best credit card app in Israel… everything can be done in the app" (08/05/2025); "UI is outdated compared with other brands", cashback opens outside app (Aug); sharing of in-app activity with sales staff led to loan calls (06/2024) — [App Store](https://apps.apple.com/il/app/מקס-max/id398915363)

**Cal**
- Description: "פירוט העסקאות" including credits and pending transactions, "עד שנה וחצי אחורה"; "גרף הוצאות חודשי" covering all cards and direct debits with up to 6 months history; change billing date ("לשנות את מועד החיוב"); split the monthly charge; credit-limit usage ("מסגרת האשראי"); insights about unusual charges, credits and foreign online purchases; rating 4.6 from 72k — [App Store](https://apps.apple.com/il/app/cal-כאל/id586226158)
- Cal's site: view transactions "לפי מועד חיוב ולפי כרטיס עד שנה וחצי אחורה וגם בחודשים עתידיים" (by billing date and card, 18 months back and future months); the monthly chart on the home page "הכולל את כל מועדי החיוב, מכל כרטיסי האשראי וכל החיובים המידיים" (all billing dates, all cards, all immediate charges) and shows spend on "מזון, דלק, פנאי, אונליין ושאר קטגוריות" — [cal-online.co.il app guide](https://www.cal-online.co.il/ecredit/articles/cal-app-features-guide/); [cal-online transactions](https://www.cal-online.co.il/self-service/alltransactions/) (search snippets; pages returned HTTP 400 to fetch)
- 2025 notes: 6.25.22 (07/12/2025) pending-transactions summary, Excel export, redesigned home; 6.25.21 (25/11/2025) installment requests from home screen; 6.26.9 "easier viewing of previous charges" — [App Store](https://apps.apple.com/il/app/cal-כאל/id586226158)
- Reviews: annoying pop-ups on every load and broken transaction search (27/08/2024); request for English interface (2023); FaceID broke after redesign and "design is worse than the old version" (2020); developer confirms no English version — [App Store](https://apps.apple.com/il/app/cal-כאל/id586226158)

### Inferences
- The card apps' mental model is "what will be debited on the next billing date"; purchase-month views exist only as secondary charts (Isracard 6-month chart, Cal 6-month graph).
- Installments are presented by the card apps as a product (split your bill) more than as a tracking aid; the only tracking affordance found is Isracard's "last payment" marker.
- Category taxonomies differ: Isracard uses "ענפים" (merchant sectors), Cal uses consumer categories (מזון, דלק, פנאי, אונליין).

### Gaps
- Max's own help pages describing category breakdowns could not be found; whether Max shows spend-by-category is unconfirmed.
- No source describes how any card app renders an installment row (e.g. "תשלום 2/6") in the list; this is well known from use but not documented in fetched sources.
- Isracard's magazine article and Cal's site pages were blocked (cookie wall / HTTP 400); only snippets were usable.

---

## Key Question 3 — Israeli bank apps and neobanks (Hapoalim, Leumi, Discount, FIBI, Pepper, One Zero) and Bit: spending-analysis features and grouping

### Takeaway
Bank Hapoalim's "פועלים UP לניהול תקציב" auto-categorises account and card spending and benchmarks each category against similar-income customers; Pepper (Leumi's digital bank) shows "התזרים החודשי" with automatic expense organisation; One Zero offers a daily "צ'ק-אפ פיננסי" scan and its ELLA assistant that pre-classifies data and now feeds generic AI agents; Discount advertises account insights (double charges, monthly income/expense analysis). Leumi's and FIBI's main apps surfaced no documented category breakdown. Bit got its first redesign in 8 years in Sept 2024 with an in-app balance; nothing documented describes its history list. A HaSolidit user reports Hapoalim auto-categorises ~90% of expenses but lumps external-card charges as one "גוש".

### Cited Findings
- Hapoalim "UP לניהול תקציב": tagline "הדרך הנוחה לעשות סדר בחשבון שלכם"; each purchase is assigned a category (examples "ביגוד והנעלה", "מזון ומשקאות"); covers account and credit card; per-category spend shown against customers with similar income; users can change a purchase's category; recommends reviewing 12 months — [bankhapoalim.co.il](https://www.bankhapoalim.co.il/poalim-up/up-budjet-management)
- HaSolidit user chen15 (7 Jan 2025, Hapoalim customer): about 90% of expenses auto-categorised, rest manual, two years of data, Excel export; limitation: charges from external credit cards sometimes appear as one lump ("גוש") — [hasolidit.com thread 33470](https://www.hasolidit.com/kehila/threads/אפליקציה-אקסל-לניהול-הוצאות-בצורה-אוטומטית.33470/)
- Pepper: section "ניתוח הוצאות ותקציב"; organises expenses automatically; shows "התזרים החודשי" (monthly cashflow) "כדי לראות לאן הכסף הולך"; "תובנות נוספות" on the "כרטיסים" screen; multiple goal-based savings plans — [pepper.co.il](https://www.pepper.co.il/)
- One Zero homepage: "צ'ק-אפ פיננסי — בכל יום נסרוק בשבילך את חשבון הבנק וכרטיסי האשראי ונציע לך דרכים לשפר את מצב הכסף שלך" (daily scan of account and cards with improvement suggestions); "תעודת זהות בנקאית" in the in-app inbox; AI trading tools — [onezerobank.com](https://www.onezerobank.com/)
- One Zero's ELLA "כבר מסווגת מראש את הנתונים, מזהה דפוסים ומייצרת תובנות" and can be connected to ChatGPT/Claude agents for insights (execution later) — [ynet](https://www.ynet.co.il/economy/article/h1c6ivdhfl)
- Discount app: insights such as double charges to a merchant, monthly expense and income analysis, summary of expenses abroad, alerts on spending-habit changes — [App Store (Discount)](https://apps.apple.com/am/app/app/id342173691); [financa bank-app comparison](https://financa.co.il/השוואת-אפליקציות-בנקים/) (snippets)
- Leumi: App Store description promises "תמונת מצב של הכנסות והוצאות ותובנות חכמות"; Leumi's open-banking page offers all accounts and all card charges (incl. non-bank cards) on one screen with insights/alerts and double-charge prevention; no category list documented — [App Store (Leumi)](https://apps.apple.com/il/app/לאומי/id337963192?l=he); [leumi.co.il/Open-Banking](https://www.leumi.co.il/Open-Banking)
- 2026 bank-app comparison lists "ניתוח הוצאות לפי קטגוריות", "קטגוריזציה אוטומטית", "תחזיות", "ייעוץ AI" as features of leading apps without attributing them per bank; digital banks credited with "עיצוב מודרני ואינטואיטיבי", traditional banks with "עיצוב פחות מודרני" and slower updates — [financecheck.co.il](https://financecheck.co.il/banking/bank-app/)
- Bit: Sept 2024 redesign — "ממשק נוח ומתקדם יותר ואפשרות לצבירת יתרה בתוך האפליקציה" (balance held in-app, money received stays in bit balance unless withdrawn), first refresh in 8 years, rolled out via pilot then stores in November — [Bank Hapoalim press release](https://www.bankhapoalim.co.il/press-releases/press-releases-items/bit-מתחדשת-אפליקציית-התשלומים-הפופולרית-עוברת-מתיחת-פנים/); [ice](https://www.ice.co.il/consumerism/news/article/1029092)
- Bit later added a short-term deposit (10–20,000 ₪, 4.06% adjusted annual) — [financa](https://financa.co.il/אפליקציית-ביט-משיקה-פיקדון-בריבית-של-4/)
- A reader comment on an ice explainer asks how to delete approved transfers from the record, implying no simple way — [ice](https://www.ice.co.il/consumerism/news/article/1028723) (snippet)
- Hapoalim's FAQ mentions only that bit transfers to contacts need no payee account details — [bankhapoalim FAQ](https://www.bankhapoalim.co.il/he/contact-us/faq)

### Inferences
- Bank tools categorise what they can see; cross-institution views depend on open banking, and lumping of external-card charges is a recurring weakness (HaSolidit).
- Neobanks (Pepper, One Zero) frame spending analysis as "cashflow"/"check-up" rather than as a transaction list redesign; the term "תזרים" is now used by Pepper as well as RiseUp.

### Gaps
- No documentation found of Leumi's or FIBI/Beinleumi's in-app category breakdown; the financa bank-app comparison body could not be read (menu-only fetch).
- No source describes the Bit history/activity screen or its row design.
- One Zero's category names and monthly views are undocumented in fetched material.

---

## Key Question 4 — Hebrew/RTL conventions for amounts, negatives, dates and mixed-script merchant names

### Takeaway
Israeli finance UIs are inconsistent on ₪ placement: RiseUp and Bank Hapoalim write "15,000 ₪" (sign after the number with a space), One Zero mixes "₪10,000" and "100,000 ₪" on one page, and the Academy of the Hebrew Language's note (as relayed) says the symbol goes to the left of the number without a space. Numbers remain LTR inside RTL text; the minus sign should render on the left ("-5", not "5-") and bidi bugs that flip it are common enough to have standard LRM/RLM workarounds. Dates in RiseUp copy use DD.MM ("30.12").

### Cited Findings
- RiseUp help text: "15,000 ₪", "5,000 ₪", "0 ₪", "550 ₪" (number, space, ₪) and date "30.12" — [איך התזרים מחושב?](https://intercom.riseup.co.il/he/articles/8890719); [איך התזרים מתייחס לחיוב באשראי?](https://intercom.riseup.co.il/he/articles/8976556)
- One Zero homepage uses both "₪10,000 נטו" / "₪2,000" / "₪50,000" and "עד 100,000 ₪" — [onezerobank.com](https://www.onezerobank.com/)
- Bank Hapoalim FAQ: fee "1.75 ₪", limit "500,000 ₪" — [bankhapoalim FAQ](https://www.bankhapoalim.co.il/he/contact-us/faq)
- Hebrew encyclopaedia entry on ₪ (relaying the Academy of the Hebrew Language): the sign should be written to the left of the number with no space, though in practice ₪ after the number and the abbreviation ש״ח are both common and used interchangeably — [hamichlol ₪](https://www.hamichlol.org.il/%E2%82%AA)
- LibreOffice bug: ₪ rendered to the right of the number in RTL; fix inserts an LRM before the shekel sign so it sits to the left like "$" — [freedesktop bug 46807](https://bugs.freedesktop.org/show_bug.cgi?id=46807)
- OpenOffice bug: Writer placed the minus to the right of digits, but "popular usage, at least for Hebrew, is otherwise"; a user typing "-3" expects the sign on the left — [Apache OOo bug 100737](https://bz-he-de.apache.org/ooo/show_bug.cgi?id=100737); GTK showed "5-" instead of "-5" under Hebrew — [GNOME bug 322571](https://bugzilla.gnome.org/show_bug.cgi?id=322571)
- Kendo UI workaround for RTL negatives: set `numberFormat.pattern[0] = "n-"` or adjust the culture pattern — [Telerik KB](https://docs.telerik.com/kendo-ui/knowledge-base/negative-number-minus-sign-position-rtl)
- Microsoft bidi guidance: numbers are read left-to-right in Arabic and Hebrew, so digits stay LTR inside RTL text — [Microsoft Learn](https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/bidirectional-support)
- Card apps list merchant names as delivered by the acquirer, often Latin-script (e.g. App Store descriptions reference tagging and searching transactions by name; Isracard tags foreign transactions) — [Isracard App Store](https://apps.apple.com/il/app/isracard-ישראכרט/id489783331); [Max App Store](https://apps.apple.com/il/app/מקס-max/id398915363)

### Inferences
- The de facto consumer-app convention in Israel (RiseUp, Hapoalim) is "1,234 ₪" with a thin/regular space; the Academy's left-of-number rule is a minority practice visible mainly in marketing copy (One Zero).
- Any RTL list mixing Hebrew labels, Latin merchant names and signed numbers needs explicit bidi isolation (LRM/RLM or `unicode-bidi: isolate`) to keep the minus on the left and the ₪ in a consistent position.

### Gaps
- No Israeli bank or card app style guide for amount/negative/date formatting was found; evidence is from copy samples and generic bidi bug reports.
- No source documents how Max/Cal/Isracard render Latin-script merchant names inside RTL rows (alignment, isolation).

---

## Key Question 5 — What Israeli users say they like/dislike about RiseUp's design and about alternatives (Finanda, החיים בפלוס, סכם לי, Hapoalim tool, spreadsheets, etc.)

### Takeaway
Hebrew-forum praise for RiseUp centres on the single main screen and the behaviour change it drives ("כמות הכסף שהאפליקציה הזאת חסכה לי היא פשוט הזויה"); criticism centres on price (55 ₪ vs Netflix/Spotify), mandatory bank connection, connection drop-outs, no cash/manual entry, lag, Hebrew-only UI, and a mobile-first web UI that "looks poor on desktop". Alternatives are judged on interface (Finanda "מאוד נוחה ואינטואיטיבית" but no category editing), on not needing passwords (החיים בפלוס, סכם לי), and on consolidation across institutions, which bank-native tools cannot do. Finbee, Budgeta, Cashcow and Dumba did not surface in any fetched Hebrew source.

### Cited Findings
- HaSolidit thread "אפליקציה לניהול תקציב משפחתי" (Jul–Aug 2024): בת העמק: "הכי מוכרת בארץ זאת רייזאפ"; necrophidius: "כמות הכסף שהאפליקציה הזאת חסכה לי היא פשוט הזויה", monthly surplus rose from ~2,500 ₪ to 6,000–12,000 ₪, credits variable/fixed tracking, the savings target and that the single main screen makes the month easy to follow, and that open banking means no passwords handed over; Know one: tried it years ago, found the WhatsApp interface "חסר תכלית ולא מדויק" (pointless and inaccurate), dislikes apps that tell users what to do; praises Finanda's interface for self-explorers but claims it still holds passwords — [hasolidit.com thread 31779](https://www.hasolidit.com/kehila/threads/אפליקציה-לניהול-תקציב-משפחתי.31779/)
- HaSolidit thread "אפליקציה/אקסל לניהול הוצאות בצורה אוטומטית" (Jan 2025): kaching "הייתה מסורבלת"; myFinanda "עזרה לי לעשות סדר… מאוד נוחה ואינטואיטיבית" with auto category/subcategory, but no way to edit/add categories (tags as workaround) and exports not split by category; Lamur: "רייזאפ משתמשת בבנקאות פתוחה ולא שומרת יוזר וסיסמא"; Roi wants to "לרכז את זה אוטומטית" across institutions; KickR warns automation makes unwanted charges harder to notice; wish-list: editable auto-categorisation, easy category creation, consolidated multi-account view, category history for year-over-year — [hasolidit.com thread 33470](https://www.hasolidit.com/kehila/threads/אפליקציה-אקסל-לניהול-הוצאות-בצורה-אוטומטית.33470/)
- Geektime (15.3.2025) on free alternative "סכם לי": some users avoided RiseUp "בגלל דמי המנוי" or data-sharing concerns and used Excel; the developer says RiseUp's web interface is built mainly for mobile and looks poor on desktop; סכם לי is manual entry into "תחומים שונים" with pre-entered fixed costs; reader comments range from "ממש עוזרת לי" to "שטויות יפות" — [Geektime](https://www.geektime.co.il/israeli-dev-built-an-app-that-rivals-riseup/)
- Geektime (17.10.2026): סכם לי passed 30,000 users, added "ייבוא נתונים מהבנק והאשראי", Apple Pay auto-capture, widgets, Siri entry, shared account, AI assistant; commenter: "חינם זה רק חלק מהסיפור" (free is only part of the story) — [Geektime](https://www.geektime.co.il/israeli-builders-app-has-more-than-30k-users/)
- TheMarker/Supermarker (updated 08/2026): RiseUp pros — automatic updates, one place, advisory team, cancel anytime, Facebook community; cons — website only (reviewer's claim, outdated vs the 2025 apps), not for businesses, unsuitable without steady monthly income; Finanda: category shares, per-category goals, Excel export, projected balance, but paid reports and shared login for couples; החיים בפלוס: manual entry with alert per expense — [supermarker.themarker.com](https://www.supermarker.themarker.com/Finance/PersonalCashFlowManagementAndFamilyBudgetInIsrael.aspx)
- Globes (2020): RiseUp's UX called "האינטואיטיבית והטובה ביותר" among the three apps; founder calls it "ווייז כלכלי" (an economic Waze); con then: required bank passwords, "לא מציעה ניתוח מורכב" — [Globes](https://www.globes.co.il/news/article.aspx?did=1001349477)
- Financa (June 2025): forum bug reports exist; users compare the price to Netflix/Spotify; cons: no cash tracking, Bank Yerushalayim unsupported, cannot remove a card without support; pros: split expenses, partner sharing, Excel export, vouchers — [financa.co.il](https://financa.co.il/רייזאפ-ביקורת/)
- Lyra (competitor, 2026): RiseUp "לרוב היקרה ביותר" in comparisons; users report partial bank coverage and disconnections requiring reconnection every few months; confusion about what is free; praise for WhatsApp alerts' sense of order and for human support — [lyra-il.com](https://lyra-il.com/blog/riseup-review)
- Moneytor (competitor): credits RiseUp with "סדר בתזרים החודשי" and "תמיכה פיננסית אנושית" as a real advantage — [moneytor.ai](https://moneytor.ai/blog/moneytor-vs-riseup)
- Blue & White Finance (English, olim-oriented): RiseUp relies on the user categorising ATM withdrawals, has no support for foreign transactions, and lacks a good solution for seasonal expenses across the year — [bluewhitefinance.com](https://bluewhitefinance.com/tools-for-tracking-your-finances/)
- RiseUp testimonials on its site: "ממשק נוח ומאוד פשוט" (convenient, very simple interface) — [riseup.co.il](https://www.riseup.co.il/) (marketing)
- No Reddit r/Israel threads about RiseUp surfaced in search — [search result summary; see Gaps]

### Inferences
- The consistent praise is about reduction (one number, one screen, few categories) and the consistent complaint is about rigidity (no manual entry, no cash, no splitting of fixed items, no month re-assignment except via bot).
- Price sensitivity is framed against streaming subscriptions, suggesting users benchmark budgeting apps against ~40–60 ₪ entertainment subscriptions rather than financial-advice fees.
- Alternatives compete on "no bank connection" (privacy/free) or on "net worth beyond cashflow" (Moneytor), not on a better transaction list.

### Gaps
- No Hebrew sources were found mentioning Finbee, Budgeta, Cashcow or Dumba; they may be defunct, renamed, or too small to be covered.
- No Reddit (r/Israel, r/PersonalFinanceIL) discussion of RiseUp was retrievable via the search tool.
- Facebook-group sentiment quoted in press was not found beyond Financa's generic "forums report bugs".
- Google Play reviews for RiseUp were not retrievable.
