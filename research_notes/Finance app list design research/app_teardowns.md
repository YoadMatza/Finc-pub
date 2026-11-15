# Finance app LIST and OVERVIEW screen teardowns (Copilot, Monarch, YNAB, Rocket Money, Emma, Revolut, Apple Card/Wallet, Lunch Money, Actual Budget, Spendee)

Scope note: facts below come from the apps' own help centres, release notes and feature pages wherever possible, supplemented by reviews and community posts. Where a fact came only from a search-result snippet (page not fetched in full) it is flagged "(snippet)". Several primary pages were unreachable (HTTP 403): Monarch help centre (help.monarch.com), Revolut help centre (help.revolut.com), Spendee review pages; gaps are listed per question. Dates are given where the source states them; anything older than 2024 is flagged as potentially superseded. Research date: 2026-11-09.

## Key question 1: Default grouping of the transaction list, and alternative groupings/views

### Takeaway
Across all ten apps the default list is a single reverse-chronological feed; none defaults to grouping by category or merchant. Alternative "groupings" are achieved through filters (category, merchant, account, review status, tag, type), sort (date vs amount), and separate structured views (Recurring tab/calendar, Spending Breakdown, merchant pages, review card stacks) rather than by re-sectioning the list itself. Only the table-based web products (Lunch Money, Actual Budget, YNAB web) expose column sorting and show/hide columns; the mobile-first apps (Copilot, Monarch, Emma, Revolut, Apple Wallet, Spendee, Rocket Money) keep a fixed feed plus a filter sheet.

### Cited Findings

**Copilot Money (iOS/Mac/iPad/Web)**
- The Transactions tab "lets you review, filter, and export your transactions. You can also create new transactions, and edit the details of existing transactions"; search finds "transactions containing a word or merchant name"; filters can be used "alone or combined". The help article does not describe how the list is grouped (date headers etc.). — [Copilot help: Transactions tab overview](https://help.copilot.money/en/articles/9554412-transactions-tab-overview)
- On web you can "sort by date or amount, either before or after applying filters"; filters: "Filter by Account, Category, Date, Recurring, Review Status, Tag, Type"; filtered results show "total spent, total income, and net". — [Copilot help: Copilot Money for Web](https://help.copilot.money/en/articles/11780342-copilot-money-for-web)
- App structure: Dashboard is the default home tab on iOS; tabs can be reordered under Settings > Appearance > App sections; other tabs are Transactions, Cash Flow, Accounts, Investments, Categories, Recurring. — [Copilot help: Dashboard tab](https://intercom.help/copilotmoney/en/articles/6045480-dashboard-tab-overview); [9to5Mac](https://9to5mac.com/?p=1000147) (snippet)
- On Mac/iPad the detail view shows "Similar Transactions" (same-name transactions and total monthly spend) — a merchant grouping accessed from the detail, not from the list. — [Copilot help: Transactions tab overview](https://help.copilot.money/en/articles/9554412-transactions-tab-overview)

**Monarch Money (iOS/Android/Web)**
- Mobile sorting "now matches the web. You can sort by date (old to new) or by amount (high to low, or low to high)" (June 20, 2024). Quick-search filters added: debit/credit, include/exclude "hidden", include/exclude synced-from-institution, has attachments/splits/notes; a new menu bar "consolidates the filters" and lets you "collapse the summary panel on the right-hand side". — [Monarch What's New, Jun 20 2024](https://www.monarch.com/blog/quicker-and-easier-transaction-review-and-more)
- Merchant view is a filter, not a grouping: "Transactions, then Filters in the upper right, then Merchants, and selecting the merchant" (community answer, Feb 2025). — [r/MonarchMoney thread](https://axebps-redlib.hf.space/r/MonarchMoney/comments/1ilrxv3/view_all_transactions_on_merchant_page) (snippet)
- Web has a "Grouping dropdown" with a "No grouping" option; users asked that "Grouping, List sort order be remembered", implying these settings are not persisted by default (2026 Reddit snapshots). — [r/MonarchMoney snapshot](https://reddit.sentinel-team.org/subreddits/MonarchMoney/snapshots/2026-03-13T08%3A55%3A55.164668Z) (snippet)
- A per-filter "summary on your transaction page on iOS or Android based on your filters (date, category, merchant, etc)" was rolling out (Jan 2026 snapshot). — [r/MonarchMoney snapshot](https://reddit.sentinel-team.org/subreddits/MonarchMoney/snapshots/2026-01-12T17%3A20%3A01.190333Z) (snippet)
- Review mode (Aug 13, 2024) presents matching transactions "as a stack of transaction cards for review" that can be filtered by "categories, merchants, or amounts" and sorted "by date or amount". — [Monarch: Review on the go and Smart Split](https://www.monarch.com/review-on-the-go-and-smart-split)
- Recurring: "View your bills and subscriptions as either a calendar or a list, all in one place." Dashboard: "Drag and drop widgets including net worth, recent transactions, investment performance, and more." — [Monarch features: transactions](https://www.monarch.com/features/transactions)

**YNAB (Web/iOS/Android)**
- "By default, transactions in the register are sorted by date in descending order." Within a date, larger outflows first, then larger inflows. Web register columns: Flags, Date, Payee, Category, Memo, Outflow, Inflow, Cleared; any column header sorts (web only); successive sorts create a secondary order. — [YNAB support: Searching, Sorting, and Filtering](https://support.ynab.com/en_us/searching-transactions-a-guide-r1gxyQryj.md)
- Search is "additive, but not subtractive" (no exclusion), no wildcards; web "is:" syntax e.g. "is: uncleared"; multi-criteria e.g. "Category: Dining Out, Outflow: >=30"; mobile offers tap-able suggestions ("Uncleared", "Split"). Web View menu: hide reconciled, show Running Balance, Flags, Photos, limit by timeframe. — same source
- The Spending tab (Sept 15, 2025 "Great YNAB Remodel") "shows spending from all accounts, lets users add transactions, and offers 'newly supercharged search (on iOS)'"; it "replaced the All Transactions view under the Accounts tab" and has a temporary "Unreconciled" filter that "is different from the Show Reconciled options" in a register. — [YNAB: The Great YNAB Remodel](https://www.ynab.com/whats-new/the-great-ynab-remodel); [YNAB support: Searching](https://support.ynab.com/en_us/searching-transactions-a-guide-r1gxyQryj.md)
- Category grouping exists only in Reflect: "Spending Breakdown is a stack-ranked view of your top categories with spending totaled up by various time frames"; tap a category to see its transactions (mobile) or click a chart section (web). — [YNAB support: Spending Breakdown](https://support.ynab.com/en_us/spending-breakdown-H1H7YxmD0.md)

**Rocket Money (iOS/Android/Web)**
- "Search transactions across accounts and view your full transaction history"; the help centre does not describe a separate Transactions screen layout. Recurring tab: "View all your subscriptions in the Recurring tab." — [Rocket Money help: Get the most out of Rocket Money](https://help.rocketmoney.com/en/articles/1940551-how-to-get-the-most-out-of-rocket-money)
- "You can find a monthly calendar view of your subscriptions and recurring expenses by clicking the calendar icon on the top right of the Recurring tab." — [Rocket Money: How team members use it](https://www.rocketmoney.com/learn/personal-finance/how-team-members-use-rocket-money) (snippet)
- Reviewers describe "a master list of transactions (pending and posted) from all checking and credit card accounts". — [Clark.com Rocket Money review](https://clark.com/save-money/rocket-money-review/amp/) (snippet)

**Emma (UK; iOS/Android)**
- Transactions live in the Feed tab: "From the Feed tab, tap See all next to Transactions to view all your transactions", which opens search and filters. — [Emma help: Transactions category](https://help.emma-app.com/en/category/transactions-1bw1563/)
- Search (Aug 27, 2020 article; may be superseded) offers 8 filters: Category, Merchant, Tags, Amount over, Amount under, Date (this/last week, month, quarter, year, or "the beginning of time"), Receipts, Account; filters combine (example: merchant ASOS + tag shoes + over £30 + last year). — [Emma blog: new search feature](https://emma-app.com/blog/new-emma-search-feature)
- Tag grouping: "You can view your spending by tag by selecting any tag on a transaction." — [Emma help: Transactions](https://help.emma-app.com/en/category/transactions-1bw1563/)
- Feed redesign (Dec 7, 2020, flagged as old): subscriptions moved to top ("Moving subscriptions at the top of the screen"), "Recent transactions" below, search made visible on the feed, Cash/Debt/Investments/Net Worth boxes, notifications moved to a separate screen. — [Emma community: New Feed Design feedback](https://community.emma-app.com/t/new-feed-design-feedback/3335)
- Later "Emma 3.0" redesign reorganised the feed "around separate tabs by theme"; one user: "Previously I could just swipe between current accounts, savings, investments etc. But now I have to go back to the main feed to select one of those categories." A feed card was removed because it was "limited by the number of tags", replaced by totals in Search and tappable tags. — [Emma community: Emma 3.0 Designs](https://community.emma-app.com/t/emma-3-0-designs/5008?page=21) (snippet)

**Revolut**
- Analytics is reached from "the 'Analytics' icon in the top right corner" of home, or via "the 'Spent this month' widget"; it "consolidates your spending and scheduled payments from all your Revolut accounts" and offers "daily, weekly, monthly or yearly spending breakdown", budgets, comparison to previous periods, and breakdown by "spending categories, specific merchants and places". — [Revolut help: How does Analytics work](https://help.revolut.com/help/app-features/budgeting-and-analytics/how-does-the-analytics-feature-work/) (snippet; page returned 403 on fetch)
- Custom categories are created from a transaction: open it, "select the current category, select 'Add custom'"; "The app will move all past related transactions here, and do the same for future ones." Users choose when the monthly analytics cycle starts. — [Revolut help: Managing Analytics categories](https://help.revolut.com/help/app-features/budgeting-and-analytics/managing-analytics-categories/) (snippet); [FinancialMarket.ro, Nov 19 2019](https://www.financialmarket.ro/fintech/digital-trends/revolut-introduces-new-and-improved-analytics-in-the-app/)
- Community complaints after a home-screen redesign: the transaction list was "pushed out in favor of promotions"; "it used to be easy to change categories and add notes, but now you need to scroll down a lot to add a note." — [Revolut community: UI Overhaul thread](https://community.revolut.com/t/ui-overhaul/147896?page=8) (snippet; thread now redirects to the help centre)

**Apple Card / Apple Wallet**
- Card screen shows "Latest Card Transactions" ("your purchases from the last month"); scroll further for "previous months and years"; the iPhone User Guide says transactions are "grouped by month and year". — [Apple Support: See your Apple Card spending history](https://support.apple.com/en-us/HT209489); [iPhone User Guide](https://support.apple.com/en-kg/guide/iphone/use-apple-card-iph8f6edb8bc/16.0/ios) (snippet)
- Search button at the bottom searches "by category, merchant, or location"; supports a date ("4/1/2026"), a range ("2/15/25-6/4/25"), and amount operators ("Transactions equal to $8.00", "over", "under"); "See All" when many match. — [Apple Support HT209489](https://support.apple.com/en-us/HT209489)
- Spending summary: under Card Balance tap "Monthly Activity"; switch Week / Month / Year; swipe right for earlier periods. — same source

**Lunch Money (Web + official mobile app)**
- Web Transactions page is a table: Quick Search "right above the Transactions table" matches payee, category or amount across fields; Quick Filter dropdown offers active month, previous month, current year, last year, "All Time"; Advanced "Filters" button with all/any conditions and custom range; click a column header to sort ("The first click will sort by descending order"); drag header dividers to resize; Notes, Accounts and Tags columns can be hidden via the Options button. — [Lunch Money support: Other features](https://support.lunchmoney.app/finances/transactions/other-features.md)
- Grouped transactions collapse to one row; "filters on the Transactions page will only display results based on the group transaction's properties" unless the "Type is part of group" filter is added. — [Lunch Money support: Transaction types](https://support.lunchmoney.app/finances/transactions/transaction-types.md)
- Official mobile app grew from the community "Lunch Money Pal" (Jan 2025); its creator joined the team. Mobile Transactions tab "only displays the Date, Payee, Category and Amount for transactions" (feedback post). Grouped transactions "are now supported in the mobile app". — [Lunch Money blog, Dec 11 2025](https://lunchmoney.app/blog/2025-12-11-community-newsletter) (snippet); [Lunch Money feedback: display notes in list](https://feedback.lunchmoney.app/mobile-app/p/mobile-app-display-notes-in-transactions-list-view) (snippet); [feedback: grouped](https://feedback.lunchmoney.app/mobile-app/p/mobile-app-support-for-grouped-transactions) (snippet)
- Mobile sort order "jumps around when filtered and making changes" (open feedback). — [Lunch Money feedback](https://feedback.lunchmoney.app/mobile-app/p/mobile-app-order-of-transactions-jumps-around-when-filtered-and-making-changes) (snippet)

**Actual Budget (self-hosted web)**
- The account register is a per-account table with header Import / Add New / Filter buttons and a search field that "lets you quickly search all fields"; active filters appear as removable chips and can be saved by name via the "Unsaved filter" dropdown; a three-dots menu toggles running balance and previously-reconciled transactions. — [Actual docs: The Account Register](https://actualbudget.org/docs/tour/accounts)
- Scheduled transactions appear in the register as upcoming rows before posting: "it becomes an upcoming scheduled transaction that posts automatically on its scheduled date"; the "upcoming length" setting controls how far ahead they show. Release 26.9.0 added a Schedule button for future-dated transactions. — [Actual docs: Schedules](https://actualbudget.org/docs/schedules) (snippet); [Actual release 26.9.0](https://actualbudget.org/blog/release-26.9.0) (snippet)

**Spendee**
- App is split into "Feed" and "Overview" tabs; Overview charts switch "between weekly, monthly, three-month, and yearly views"; "Each category with transactions appears there with its total." — [Millennial Money Spendee review](https://millennialmoney.com/spendee-review) (snippet; page 403 on fetch)

### Inferences
- "Grouping" in these products is almost always a filter + summary pattern rather than a true sectioned list; the one explicit "Grouping" control (Monarch web) is noted by users as not persisting.
- Table-based web products (Lunch Money, Actual, YNAB web) treat the list as a spreadsheet (sortable columns, saved filters); mobile-first products treat it as a feed with a filter sheet and a secondary structured view (Recurring calendar, Breakdown).

### Gaps
- No primary source states whether Copilot, Monarch mobile, Emma, Revolut or Spendee insert day headers vs month headers in the feed; help articles rely on screenshots with no alt text.
- Revolut help pages returned HTTP 403; all Revolut facts are from search snippets or a 2019 press article.
- Spendee has no reachable help-centre content; only the marketing page and a 403'd review.

## Key question 2: What is on one transaction row, and what moves to the detail screen (incl. pending, refunds, transfers, installments)

### Takeaway
Rows are two-line in every mobile app (name + secondary line; amount right-aligned) with a leading logo/category icon; type/status is signalled with small glyphs (Copilot's [I]/[T]/[R] and light-blue unreviewed dot, Lunch Money's turquoise text and amount-field icons, Actual's grey/green cleared circle). Notes, tags, receipts/attachments, maps, splits, "similar transactions", rule creation and the original bank description are consistently pushed to the detail screen. Pending is either hidden (Emma shows most as settled by design), shown as a status field with an expected clear date (Revolut), or excluded from totals (Apple interest estimate, Emma budgets).

### Cited Findings

**Copilot**
- Type badges in the list: "[I] indicates Income", "[T] indicates Internal Transfer", "[R] indicates Recurring". Types: Income ("appears in its own section of the app and is not counted in spending budgets"), Internal Transfer ("excluded from spending budgets"), Regular ("Spending, or money received as a refund... can also be flagged as Recurring"). — [Copilot help: Transaction types](https://intercom.help/copilotmoney/en/articles/3971267-transaction-types)
- Refunds: "a refund for a returned purchase should be marked Regular" (so it nets against the category); credits can be marked Income or Regular. The page says nothing about pending or installments. — same source
- "The light-blue unreviewed transaction indicator will show next to any transactions for review throughout the app." — [Copilot for Web](https://help.copilot.money/en/articles/11780342-copilot-money-for-web)
- Detail view: tap date or name to edit; change type and category; split; mark recurring; Mac/iPad show "Similar Transactions"; "there is currently no option to view original transaction info" on Mac/iPad. — [Copilot help: Transactions tab](https://help.copilot.money/en/articles/9554412-transactions-tab-overview)
- Changing type offers to "apply the change to similar transactions" via a name rule (exact or partial match) or "No thanks" for the single transaction. — [Copilot help: Transaction types](https://intercom.help/copilotmoney/en/articles/3971267-transaction-types)

**Monarch**
- June 2024: "Category and account details now appear in the main transaction list, so you have less to click through"; hide / mark-reviewed buttons sit "at the top of each detailed transaction page". — [Monarch What's New, Jun 2024](https://www.monarch.com/blog/quicker-and-easier-transaction-review-and-more)
- Review card (mobile) lets you "quickly edit the category and add tags, notes, or a split from the card". — [Monarch: Review on the go](https://www.monarch.com/review-on-the-go-and-smart-split)
- Filters for "attachments, splits or notes" imply these are detail-level properties. — [Monarch What's New, Jun 2024](https://www.monarch.com/blog/quicker-and-easier-transaction-review-and-more)
- Criticism (predates the June 2024 change): "It bugged me also that Monarch did not list accounts in the transaction list, and you had to drill down. Also, the list was very spread out" vs Simplifi's "compact view". — [Simplifi community comparison](https://community.simplifimoney.com/discussion/comment/31511) (snippet; login-walled)

**YNAB**
- Web row = Flags, Date, Payee, Category, Memo, Outflow, Inflow, Cleared; optional Running Balance and Photos columns; Cleared column sorts across "uncleared, cleared, pending, and reconciled" statuses. — [YNAB support: Searching/Sorting](https://support.ynab.com/en_us/searching-transactions-a-guide-r1gxyQryj.md)
- Selecting rows shows a selected total ("the selected total will appear in the top right hand corner"; mobile shows a running selected total). — same source

**Rocket Money**
- Reviewers: unified list of "pending and posted" transactions; Premium users "can manually tag transactions to track spending for specific purposes that span multiple categories". — [Clark.com](https://clark.com/save-money/rocket-money-review/amp/) (snippet); [Rocket Money feature page](https://rocketmoney.com/feature/manage-subscriptions) (snippet)

**Emma**
- Logos: merchant logo per row, matched against "a merchant in our database"; wrong/missing logo fixed via the transaction's "Something wrong?" section / "Add custom logo"; "Logos cannot currently be added to incoming transactions." — [Emma help: Transactions](https://help.emma-app.com/en/category/transactions-1bw1563/); [Emma help: logos](https://help.emma-app.com/en/article/add-or-change-transaction-logos-rry727/)
- Pending: "Pending items are not editable and do not count toward budgets or reports. Emma shows some transactions as settled, which lets you edit and categorise them right away. Pending items are not labelled as such unless Emma is unsure they will clear." A transaction may look settled in Emma while pending in the bank app: "This isn't a bug — it's by design." — [Emma help: Transactions](https://help.emma-app.com/en/category/transactions-1bw1563/); [Emma help: pending](https://help.emma-app.com/en/article/why-are-some-transactions-pending-in-my-banking-app-and-not-in-emma-1chsgpk/)
- Detail-level actions: notes ("Add note"), receipts ("add receipt" after scrolling down), tags, date change (Pro/Ultimate only), exclude ("Excluding a transaction will stop it from being counted towards your spending"), "Transfer category". — [Emma help: Transactions](https://help.emma-app.com/en/category/transactions-1bw1563/)
- Open feature request: "Bank logos in transaction and committed spending lists." — [Emma community](https://community.emma-app.com/t/bank-logos-in-transaction-and-committed-spending-lists/639)

**Revolut**
- Pending card payments show an estimated reversal date "under the transaction's Status section"; "typically, pending transactions are cleared within a few business days". — [Revolut help: Why is my card payment pending](https://help.revolut.com/help/card-payments-withdrawals/paying-by-card-issues/why-is-my-card-payment-pending) (snippet)
- Pay Later (instalments): on full refund Revolut "cancels the instalment plan and refunds the paid principal and fee"; a merchant refund "may not be linked to the original transaction". — [Revolut help: Pay Later issues](https://help.revolut.com/en-IE/help/credit-products/pay-later/issues-with-pay-later-transactions/) (snippet)
- 2019 Analytics redesign: "spike indicators" label a spending spike as rent/travel/groceries; estimated month-end spend. — [FinancialMarket.ro](https://www.financialmarket.ro/fintech/digital-trends/revolut-introduces-new-and-improved-analytics-in-the-app/) (flag: 2019)

**Apple Card / Wallet**
- Detail: "Tap a transaction, then tap it again to see details"; shows Related Receipts from Mail/Photos (swipe left > Remove to unlink); with Family "who made a purchase"; change category individually or via "Select Multiple Transactions". — [Apple Support HT209489](https://support.apple.com/en-us/HT209489)
- Third-party description of the detail: "price, Daily Cash, category, and the location of the transaction on a map", merchant name instead of raw merchant code. — [9to5Mac Apple Card guide](https://9to5mac.com/guides/apple-card/page/2) (snippet)
- Installments: "Your installment automatically appears on your Apple Card statement alongside your everyday Apple Card purchases in the Wallet app"; details on the Monthly Installments screen. — [Apple Support (archived Jan 2022)](https://webcf.waybackmachine.org/web/20220123000208/https://support.apple.com/kb/HT210644) (flag: 2022 archive)
- Feature page: "See each purchase go through right away. No waiting. No wondering."; "See your spending by color and category."; "View item-by-item receipts from your Apple services."; "Easily pin down your spending with Maps" (footnote: "Some transactions may not be displayed in Maps"); payment-wheel interest estimates "do not include pending transactions". — [Apple Card features](https://www.apple.com/apple-card/features/)
- Abroad: "Wallet shows the converted amount but drops the original currency" (third-party, commercial source). — [Finny blog](https://getfinny.app/blog/apple-wallet-spending-summary-not-enough) (snippet)

**Lunch Money**
- Split: "Each split amount will then appear as a single entry in the Transactions page" with a "symbol... within the Amount field"; hover shows original and related amounts; "You will not be able to proceed if the split amounts don't add up". Grouped: "display as a single entry in the table" with an icon in the Amount field; individuals "hidden from the default table view"; the group has its own date/category/payee/notes/tags. Recurring-linked rows show "an icon" next to Amount and text "colored in turquoise for quick identification". — [Lunch Money support: Transaction types](https://support.lunchmoney.app/finances/transactions/transaction-types.md)
- Mobile row = Date, Payee, Category, Amount; notes only in detail (open request). — [Lunch Money feedback](https://feedback.lunchmoney.app/mobile-app/p/mobile-app-display-notes-in-transactions-list-view) (snippet)

**Actual Budget**
- Row: checkbox left of date; Payee and Category dropdowns; cleared checkbox column far right (toggleable); split rows expand/collapse with arrows; selected rows show combined balance beside the account balance; notes via a note icon ("Actual fully supports Markdown"). — [Actual docs: Account Register](https://actualbudget.org/docs/tour/accounts)
- Transfers between two on-budget accounts "have no category at all. Actual marks these types of transfers with Transfer in the category field"; deleting a transfer deletes both sides. — [Actual docs: Transfers](https://actualbudget.org/docs/transactions/transfers) (snippet)
- Cleared state: "Transactions not yet verified against your bank show a gray pending flag. Clicking the gray circle turns it green"; reconciliation ends with "Lock transactions". — [Actual docs: Reconciliation](https://actualbudget.org/docs/accounts/reconciliation) (snippet)

**Spendee**
- Marketing: add "a picture or a location to every expense"; rows show negative amounts ("-280 USD") next to names like "Rent"; user complaint: "cannot assign a category, label, or edit a description until the transaction is confirmed" (pending). — [Spendee.com](https://www.spendee.com/); [Capterra reviews](https://www.capterra.com/p/238829/Spendee/reviews/) (snippet)

### Inferences
- The consensus "row contract" is: logo/icon, merchant name, one secondary line (category and/or account), amount; status via a small glyph. Notes, tags, attachments, geo, splits and rule creation are universally detail-level.
- Refund handling diverges: Copilot nets refunds into the category (Regular), YNAB surfaces them in Reflect as "Positive Inflow Categories", Lunch Money lets users physically group refund+purchase into one row.

### Gaps
- No primary source gives a field-by-field description of the Copilot, Monarch mobile, Emma, Revolut, Rocket Money or Spendee row (screenshots only).
- Apple's current support page does not describe pending or Daily Cash display; installment behaviour is from a 2022 archive.

## Key question 3: How the monthly overview splits spending (fixed/recurring vs flexible vs "fun", savings, debt) and who uses a "flex"/"free to spend" concept

### Takeaway
Three distinct models exist: (a) Monarch's explicit three-bucket "Fixed / Non-Monthly / Flex" budget (its default mode) where Flex = Income − Fixed − Non-monthly − Goals; (b) a single "left to spend" number that subtracts committed/recurring bills (Copilot "Free to Spend" with recurrings excluded from the pace chart, Emma "Committed Spending" → "left of", Rocket Money "Left for spending", Revolut estimated month-end spend); (c) category/envelope ledgers with no fixed-vs-flex split (YNAB Plan, Actual Budget, Lunch Money, Spendee, Apple Wallet's colour-coded categories). None of the sources uses the literal term "fun money"; Monarch's Flex bucket ("Some are needs, and some are wants") is the closest.

### Cited Findings

**Copilot**
- Dashboard graph: "Free to Spend" at top (example "$1,380 left"), "the amount of money that can still be spent without going over budget for the month"; "Expected recurring transactions for the current month are excluded from the chart"; a dotted ideal-pace line vs a solid actual-pace line whose colour changes with the day of the month. Dashboard sections: Graph, To Review, Budgets (trending categories), Upcoming (horizontally scrolling recurrings), Net This Month (income vs spending incl. excluded spending, MTD vs prior MTD), Free Months (referrals). — [Copilot help: Dashboard tab](https://intercom.help/copilotmoney/en/articles/6045480-dashboard-tab-overview)
- Categories tab: top chart is "a comparison of the amount spent this month and your total budget for the month" (or vs previous month if no budgets); categories listed below "organized by spend amount"; bar colours green (on pace) → yellow/orange (on pace to exceed) → red (over); "Outlined bars represent expected spend from" recurrings; past months show only green or red; tap the chart for yearly totals and average monthly spend; change a budget in the category detail "by tapping on the budget line label". — [Copilot help: Categories tab](https://help.copilot.money/en/articles/9504513-categories-tab-overview)
- Budgeting is optional: without budgets the dashboard compares this month's spending to last month and the Category view has no budget line; categories can be excluded so "spending in excluded categories will not be included in the total spending". — [Copilot help: Optional budgeting](https://help.copilot.money/en/articles/6282850-optional-budgeting) (snippet)
- Open roadmap request: "Overall budget: income, savings, bills, safe to spend" — indicating no built-in income-minus-bills-minus-savings waterfall today. — [Copilot roadmap](https://roadmap.copilot.money/feature-requests/p/overall-budget-income-savings-bills-safe-to-spend) (snippet)

**Monarch**
- "In flex budgeting (the default in Monarch), you'll focus instead on tracking your flexible spending." Buckets: Fixed ("predictable, recurring expenses that don't change much month to month and can't easily be reduced"), Non-Monthly (target + frequency; Monarch "will automatically split up an amount across the next 12 months"), Flex ("subtracts your fixed expenses, non-monthly expenses, and goals from your income"; money can only be moved to/from "the flexible spending bucket as a whole, not the individual categories inside it"). — [Monarch help: Flex budgeting](https://help.monarch.com/hc/en-us/articles/32125337244052) (snippet; page 403 on fetch)
- Formula: "Income - Fixed Expenses - Non-monthly expenses - Goals = Monthly Flex Number"; weekly flex = monthly ÷ 4.3; example $6,400 − $2,000 − $1,000 − $200 = $3,200 (weekly ≈ $744.19). Suggested Fixed: rent/mortgage, insurance premiums, loan minimums, gym, subscriptions, utilities, phone, childcare. Non-monthly: taxes, gifts, car/home repairs, travel, annual subscriptions, annual insurance. Flexible: groceries, gas, copays, shopping, restaurants, entertainment, hobbies ("Some are needs, and some are wants"). Status colours: green <50%, yellow 50–99%, red ≥100%; rollover per category; variable-frequency non-monthly items; "Users can switch between category and flex budgets in budget settings"; weekly view and per-household-member flex numbers. — [Monarch blog: Fixed/Flex spending](https://www.monarch.com/blog/fixed-flex-spending-what-it-is-and-how-to-get-started)
- Mobile budget criticism: "On mobile, I can only see the total for the group, there's no way to see that $400 was dining and $1600 was grocery." — [r/MonarchMoney snapshot](https://reddit.sentinel-team.org/subreddits/MonarchMoney/snapshots/2026-01-24T07%3A40%3A22.40417Z) (snippet)

**YNAB**
- Sept 15, 2025 remodel: Home tab = "the new command center for your plan" with plan alerts, pinned priority categories, progress on this month's targets and "getting a month ahead", quick-add, curated resources, support; Spending tab for all transactions; "Both the Android and iOS apps have newly improved visual designs". — [YNAB: Great Remodel](https://www.ynab.com/whats-new/the-great-ynab-remodel)
- "Budget" renamed "plan" everywhere (May 2025): "we're all about intention, not restriction." — [YNAB: First impressions reimagined](https://www.ynab.com/whats-new/first-impressions-reimagined) (snippet)
- Spotlight: "a new area of the app designed to help you build a flexible plan that reflects your values, with prioritized alerts and pinned categories". — [YNAB: That's you in the Spotlight](https://www.ynab.com/whats-new/thats-you-in-the-spotlight) (snippet)
- Spending overview = Reflect > Spending Breakdown: stack-ranked categories by percentage; separate "Positive Inflow Categories" section (inflows > outflows, e.g. reimbursements); credit-card interest excluded; hidden categories shown "in their original groups" with an eye icon; mobile presets last 3/6/12 months, YTD, previous year, all dates; "Preset date ranges include the current month, even if the month isn't complete yet." The web Spending Report was removed in favour of Breakdown + Trends. — [YNAB support: Spending Breakdown](https://support.ynab.com/en_us/spending-breakdown-H1H7YxmD0.md)
- No fixed/flex split: YNAB's model is category envelopes; the Jan 2025 method refresh reframed the rules, e.g. "what can I set aside for next month's spending? (Resilience)". — [Jesse Mecham Show episode](https://pocketcasts.com/podcast/the-jesse-mecham-show/a63155c0-ec20-012e-dfe8-525400c11844/ynab-method-overhaul-not-really/24742cee-41ad-49ea-b3fe-d24fb88784e9) (snippet)

**Rocket Money**
- Spending tab: "see where your money goes and how it changes over time"; "Get monthly spending reports and detailed breakdowns across all categories"; budgets start from the Spending tab; edit categories via "the Settings (⚙️) icon under your Spend pie chart"; "Budgets are currently available to Premium and Premium+ members". — [Rocket Money help](https://help.rocketmoney.com/en/articles/1940551-how-to-get-the-most-out-of-rocket-money)
- Dashboard shows "a running total of 'left for spending' after regular bills and goals are accounted for"; free plan includes two custom budget categories, Premium "Unlimited budgets". — [Motley Fool review](https://www.fool.com/money/personal-finance/rocket-money-review)
- "The Spending page will track your income and outgoings, presenting them to you in the form of a graph." — [Spokesman-Review/USA Today, Jun 2026](https://www.spokesman.com/stories/2026/jun/09/does-rocket-money-actually-help-you-save-cash/) (snippet)

**Emma**
- "Committed Spending can be found in the Budgeting section of the Emma Feed tab" (Feed > Budget circle chart > Committed Spending); it is "used to calculate how much you have left to spend for the month"; "Your upcoming payments are sourced from the Recurring payments section in your Feed tab"; "Currently, you can only include recurring payments in Committed Spending"; excluded items are "usually credit card repayments or internal transfers, which should remain excluded". — [Emma help: Committed spending](https://help.emma-app.com/en/article/learn-committed-spending-1cg2t8v/)
- "Your 'left of' is what's remaining from the total budget you have set in Emma; this is computed by taking your total budget and subtracting both committed and past spending." Paid items drop out of the committed view. — [Emma community: Where is Committed Spending](https://community.emma-app.com/t/where-is-the-committed-spending-screen/3680) (snippet)
- Emma staff on scope: "committed spending is just a label we use in the app to show what the app knows is going to happen. If Committed didn't exist, a budget would still work out." — [Emma community](https://community.emma-app.com/t/committed-recurring-payment-for-an-amount-in-a-category/6589) (snippet)

**Revolut**
- Analytics shows the "Spent this month" widget, breakdown by categories/merchants/places, per-category budgets (paid plans, per third party), comparison to previous periods, user-chosen cycle start date. — [Revolut help](https://help.revolut.com/help/app-features/budgeting-and-analytics/how-does-the-analytics-feature-work/) (snippet); [Freenance guide](https://freenance.io/integrations/revolut-budget-tracking-complete-guide-2026/) (snippet; third party)
- 2019 redesign added estimated month-end spend ("Say goodbye to the stress of guessing how much money you'll have left at the end of the month") and a red budget indicator ("If it goes red, that's an indicator that you're heading towards exceeding your budget"). — [FinancialMarket.ro, Nov 2019](https://www.financialmarket.ro/fintech/digital-trends/revolut-introduces-new-and-improved-analytics-in-the-app/) (flag: 2019)

**Apple Card / Wallet**
- Monthly Activity summary: Week/Month/Year; "Under 'Total Spending,' a message shows how much more or less you spent compared to the previous period". — [Apple Support HT209489](https://support.apple.com/en-us/HT209489)
- Categories such as Shopping, Food & Drinks, Services; "the colors are fixed rather than customizable, and Apple chose the spending categories" (commentary). — [AppleInsider forum](https://forums.appleinsider.com/discussion/210364) (snippet)
- UK-only "spending highlights for your connected account" extends the summary to linked bank accounts. — [Apple Support 123096](https://support.apple.com/en-ca/123096) (snippet)

**Lunch Money**
- Recurring items are a first-class object ("Transactions that repeat regularly are represented with Recurring items", expense or income, amounts "don't necessarily need to be the same"). Budget is category-based; no fixed/flex concept found. — [Lunch Money support: Transaction types](https://support.lunchmoney.app/finances/transactions/transaction-types.md)

**Actual Budget**
- Budget page: left column of category groups (incl. income); per month three columns "Budgeted, Spent, and Balance"; Balance ≈ Budgeted − Spent + previous leftover "as a rule of thumb"; month menu copies last month / sets zero / sets 3-6-12-month average; months visible "defined by the width of your screen"; per-month Markdown notes. — [Actual docs: Budget](https://actualbudget.org/docs/tour/budget)

**Spendee**
- Overview: "Total expenses", "Avrg expenses", "Busiest day"; percentage charts by category; budgets show "how much you can spend daily to stay within a budget". — [Spendee.com](https://www.spendee.com/)

### Inferences
- The "fun/flex" idea is operationalised either as a residual number (Monarch Flex, Copilot Free to Spend, Emma left-of, Rocket Left for spending) or not at all (envelope apps). Monarch is the only one that renders the three buckets as sections of the budget screen.
- Copilot and Emma both subtract known upcoming recurrings from the monthly picture, but only count rows actually flagged recurring — a failure mode Emma acknowledges ("If the upcoming payment isn't marked as a recurring payment, it won't show up in Committed Spend").

### Gaps
- Monarch's help article on Flex budgeting (how the three buckets are visually laid out, rollover rules) could not be fetched (403); the blog post's screenshots have no text.
- Could not confirm whether Copilot's "Free to Spend" number subtracts upcoming recurrings or only excludes them from the chart.
- No source describes Rocket Money's "Spending Insights"/month-comparison UI in detail.

## Key question 4: Uncategorised rows, review queues and bulk categorisation

### Takeaway
A "review inbox" is a defining feature of Copilot, Monarch and Lunch Money (imported transactions start unreviewed; a banner/section drives you to zero), while Emma, Revolut, Apple Wallet, Rocket Money and Spendee have no review state and rely on auto-categorisation plus merchant-wide "apply to all" edits. Bulk actions are strongest on web/desktop (keyboard shortcuts in Copilot Mac/Web; multi-select in Actual, Lunch Money, YNAB, Apple Wallet) and on mobile take the form of swipe-to-review card stacks (Monarch) or "Select All from merchant" (Emma).

### Cited Findings
- Copilot: Dashboard "To Review" section "Lists newly imported transactions you haven't marked as reviewed"; a "MARK AS REVIEWED" button dismisses them in bulk; "view all >" opens the Transactions tab. — [Copilot help: Dashboard](https://intercom.help/copilotmoney/en/articles/6045480-dashboard-tab-overview)
- Copilot Intelligence: per-user model that "predicts categories from transactions you've already reviewed, and surfaces the top two guesses at the front of the list when it's wrong"; requires reviewing 30 transactions; recommends keeping "To Review" at zero. — [Copilot help: Copilot Intelligence for spending](https://intercom.help/copilotmoney/en/articles/8182433-copilot-intelligence-for-spending) (snippet)
- Copilot web/Mac keyboard: arrows move, "X selects a transaction, R marks it reviewed, and C opens category editing. Command+A selects all, and Command+Shift+A deselects all"; bulk "changing the category, review status, and transaction type"; when changing type you are offered a name rule. — [Copilot for Web](https://help.copilot.money/en/articles/11780342-copilot-money-for-web); [Copilot transaction types](https://intercom.help/copilotmoney/en/articles/3971267-transaction-types)
- Monarch: "Swipe to quickly review or edit transactions as they come in" (feature page); Aug 2024 Swipe-to-Review: dashboard banner "let's review some transactions" shown "only when transactions are marked as needing review"; stack of cards; swipe right = reviewed, swipe left = skip; filter the queue by category/merchant/amount; goal "2x faster". Smart Split rules by "merchant, amount, account, or category", by fixed amounts or percentages, applied retroactively or forward. — [Monarch features](https://www.monarch.com/features/transactions); [Monarch: Review on the go](https://www.monarch.com/review-on-the-go-and-smart-split)
- Monarch June 2024: hide / mark-reviewed buttons on the detail page; filters for hidden and synced-from-institution; "Rapid Transaction Review" previewed as "quickly review, edit, or hide new transactions with a swipe". — [Monarch What's New Jun 2024](https://www.monarch.com/blog/quicker-and-easier-transaction-review-and-more)
- Monarch newly detected recurring merchants are highlighted "so you can review and edit them before they are added to your recurring page". — [Monarch features](https://www.monarch.com/features/transactions)
- Lunch Money: "Unless automatically marked as reviewed by a Rule, all automatically imported transactions will initially be marked as 'unreviewed'"; a prompt "on the right-side of the screen to review those transactions" opens a filtered list; Settings offer auto-review-on-edit and auto-review for manual transactions; "Rules will override auto-review settings"; weekly digest email of unreviewed items (default Thursday). — [Lunch Money support: Transaction status](https://support.lunchmoney.app/finances/transactions/transaction-status) (snippet); [Lunch Money rules](https://support.lunchmoney.app/setup/rules) (snippet)
- Lunch Money mobile: open request "Quick Access to Unreviewed Transactions"; bug report "New transactions don't trigger rules" on mobile. — [Lunch Money feedback](https://feedback.lunchmoney.app/mobile-app/p/mobile-app-quick-access-to-unreviewed-transactions) (snippet); [feedback](https://feedback.lunchmoney.app/mobile-app/p/mobile-app-new-transactions-dont-trigger-rules) (snippet)
- YNAB: search/filter by "approved/unapproved" and "matched"; select-all checkbox for the filtered set; Spending tab lets you "take action on multiple transactions". — [YNAB support: Searching](https://support.ynab.com/en_us/searching-transactions-a-guide-r1gxyQryj.md); [YNAB support: Spending Breakdown](https://support.ynab.com/en_us/spending-breakdown-H1H7YxmD0.md) (snippet)
- Emma: "When changing a category, select 'Select All' to apply it to every transaction from the same merchant. Multi-editing is available for categories, references and tags"; "After you recategorise a few similar transactions, Emma applies that category to new similar ones automatically." No review state documented. — [Emma help: Transactions](https://help.emma-app.com/en/category/transactions-1bw1563/)
- Revolut: a custom category created from a transaction moves "all past related transactions here, and... future ones". — [Revolut help: Managing categories](https://help.revolut.com/help/app-features/budgeting-and-analytics/managing-analytics-categories/) (snippet)
- Apple Wallet: change category per transaction or via "Select Multiple Transactions". — [Apple Support HT209489](https://support.apple.com/en-us/HT209489)
- Rocket Money: Rules screen via "the gear icon, then 'Categories and Rules'" shows how many transactions match a rule. — [Rocket Money: How team members use it](https://www.rocketmoney.com/learn/personal-finance/how-team-members-use-rocket-money) (snippet)
- Actual Budget: the selected-count control next to search opens a menu of actions; "Bulk Actions" documented separately. — [Actual docs: Account Register](https://actualbudget.org/docs/tour/accounts)
- Spendee: a user could not find "automatic re-categorization of a merchant's transactions, past and future". — [Capterra Spendee reviews](https://www.capterra.com/p/238829/Spendee/reviews/) (snippet)

### Inferences
- The review-queue apps (Copilot, Monarch, Lunch Money) all pair the queue with an entry point on the home/dashboard (section, banner, side prompt) and a one-tap/one-key "reviewed" action; the queue doubles as the training signal for their categorisers.
- Apps without a review state compensate with merchant-wide propagation ("Select All", custom category moving past and future rows).

### Gaps
- No primary description of Copilot's iOS swipe/long-press gestures on list rows was found.
- Rocket Money's categorisation/rules UI is documented only in blog posts, not the help centre.

## Key question 5: Which apps are praised for calm, low-density design, and what makes them so

### Takeaway
Copilot is the consensus "calm/polished" pick (Apple Design Award finalist 2024, Editor's Choice; sponsor copy "designed to feel calm and intuitive"; reviewers "best-in-class", "clean and fast"), with the praise attributed to native Apple idioms, Swift Charts, smooth animation and putting "financial data front and center without the noise". Monarch is described as "clean but functional"/Mint-like; Rocket Money "clean, modern... once you spend a little time with it". Density criticism is concrete for Emma's feed (wasted vertical space, padding, empty £0 boxes, weather widget), pre-2024 Monarch ("very spread out", no account on the row) and Revolut (promotions pushing the list down).

### Cited Findings
- Copilot FAQ: "We've received the Apple Design Award Finalist (2024) and Apple Editor's Choice in Personal Finance"; interface described as polished and deliberately calm, "putting your financial data front and center without the noise". — [Copilot FAQ](https://www.copilot.money/faq) (snippet)
- Gruber (Dec 28, 2025, disclosed sponsorship): Copilot embraces "the design idioms and technical features of truly native apps for Apple platforms"; cites an Apple Developer feature on its Swift Charts use; presents data "in clear, intuitive ways"; web app "designed with all the attention to detail... as their native apps"; sponsor copy: "designed to feel calm and intuitive". — [Daring Fireball](https://daringfireball.net/linked/2025/12/28/copilot-money)
- Reviewers: "genuinely best-in-class", "every animation is smooth"; counterpoint "beautiful design is not the same as the right tool for the job"; Reddit (relayed): "power users who check it daily tend to love it, while casual budgeters often feel they're overpaying". — [Freenance review](https://freenance.io/products/copilot-money-review-2026-budgeting-app-iphone-best-design/) (snippet); [Envelope Budgeting review](https://envelopebudgeting.com/articles/copilot-money-review) (snippet)
- Monarch vs Copilot: Monarch "clean but not quite at Copilot's level of polish", "won't win design awards but keeps everything where you'd expect"; Monarch layout "Mint-like, with an account grid, a net-worth headline, and a category pie chart". — [Origin comparison](https://useorigin.com/resources/blog/copilot-vs-monarch-which-is-better-for-your-financial-life) (snippet; competitor blog); [Finny comparison](https://getfinny.app/blog/copilot-money-vs-monarch-money-2026) (snippet; competitor blog)
- Monarch density: "Monarch did not list accounts in the transaction list, and you had to drill down. Also, the list was very spread out" vs Simplifi's compact view. — [Simplifi community](https://community.simplifimoney.com/discussion/comment/31511) (snippet). Monarch addressed the account-on-row point in June 2024. — [Monarch What's New](https://www.monarch.com/blog/quicker-and-easier-transaction-review-and-more)
- Monarch clutter from upsells: product "felt cluttered with these sorts of upsells". — [r/MonarchMoney snapshot](https://reddit.sentinel-team.org/subreddits/MonarchMoney/snapshots/2026-04-28T03%3A15%3A09.836694Z) (snippet)
- Rocket Money: "Menus are intuitive"; layout "clean, modern, and easy to navigate, once you spend a little time with it"; "dive into a spending category without losing your place"; charts: "Rocket Money has this too, but Monarch Money does it better." — [Motley Fool](https://www.fool.com/money/personal-finance/rocket-money-review)
- Emma feed (Dec 2020 redesign thread; old): praise "Looks nice bit more clear layout", "The feed did need a revamp for quite a while"; criticism "Some things are expensive to waste screen real estate (especially vertically) on", "Why do we need weather in a finance app?", "The top/bottom padding of the boxes could be minimised a little bit", "a few chunky boxes with £0 which won't change", "the whole structure needs a bit of a rethink", requests for widget order/visibility control. — [Emma community: New Feed Design](https://community.emma-app.com/t/new-feed-design-feedback/3335)
- Revolut: users say the transaction list was "pushed out in favor of promotions" and notes now require scrolling. — [Revolut community UI Overhaul](https://community.revolut.com/t/ui-overhaul/147896?page=8) (snippet)
- Apple Card: 9to5Mac contrasts Wallet's merchant names and maps with statements' "jumbled lists of transactions and merchant IDs". — [9to5Mac guide](https://9to5mac.com/guides/apple-card/page/5) (snippet)
- YNAB mobile (third-party, competitor): "functional but limited compared to the web version" for reports/budget adjustments. — [PocketClear blog](https://pocketclear.app/blog/ynab-complaints-problems.html) (snippet)
- Lunch Money tagline: "Delightfully simple personal finance & budgeting". — [lunchmoney.app](https://lunchmoney.app/)

### Inferences
- "Calm" praise correlates with: native platform controls, one hero number per screen (Free to Spend), a pace line instead of tables, and hiding secondary fields in the detail. Density complaints correlate with promo/upsell cards, fixed-height widgets with empty states, and lists that omit a key field (account) forcing drill-down.

### Gaps
- Most "Reddit sentiment" is relayed by affiliate/competitor blogs; direct r/CopilotMoney or r/ynab threads on list density were not retrievable in this pass.
- No independent (non-sponsored) 2025–2026 design critique of Copilot was found.

## Key question 6: Published screenshots or design case studies explaining the reasoning behind these layouts

### Takeaway
First-party design rationale is thin: Copilot's help pages explain the pace-line/Free-to-Spend logic and why recurrings are excluded; Monarch's blog explains the Fixed/Flex maths and the "2x faster" review goal; YNAB's remodel post frames Home as a "command center" and the rename to "plan" as "intention, not restriction"; Apple's feature page gives one-line intents ("No waiting. No wondering."). Third-party teardowns found: a Kristen Berman (Irrational Labs) video on Copilot's behavioural design, Craft Innovations' Revolut AIR UX breakdown (2026), a Uxcel heuristic evaluation of Revolut, and a 2019 Revolut Analytics launch article; no Mobbin/growth.design/Page Flows case study on any of these transaction lists surfaced.

### Cited Findings
- Copilot rationale for excluding recurrings from the pace chart: "Large early-month payments, such as rent or a mortgage, can cause spikes. Setting them up as Recurrings keeps them off the graph." — [Copilot help: Dashboard](https://intercom.help/copilotmoney/en/articles/6045480-dashboard-tab-overview)
- Copilot screenshots exist in help articles (filters, transaction detail) but have no textual description. — [Copilot help: Transactions tab](https://help.copilot.money/en/articles/9554412-transactions-tab-overview)
- Kristen Berman teardown video "Copilot: we can do hard things" covers transaction categorization, empty states, budgeting, notification opt-ins. — [Kristen Berman Substack](https://kristenberman.substack.com/p/copilot-we-can-do-hard-things) (snippet)
- Monarch states transactions are the app's "most visited page" and designed Swipe-to-Review to make reviewing "2x faster" during short breaks. — [Monarch: Review on the go](https://www.monarch.com/review-on-the-go-and-smart-split)
- YNAB: Home tab "the new command center for your plan"; rename to plan "Because we're all about intention, not restriction." — [YNAB Great Remodel](https://www.ynab.com/whats-new/the-great-ynab-remodel); [YNAB rename](https://www.ynab.com/whats-new/first-impressions-reimagined) (snippet)
- Revolut 2019 Analytics rationale: "making it even easier to keep track of your money", "more control over things like categories and budgeting". — [FinancialMarket.ro](https://www.financialmarket.ro/fintech/digital-trends/revolut-introduces-new-and-improved-analytics-in-the-app/)
- Craft Innovations' 2026 Revolut AIR UX breakdown: the assistant "works best as a search layer over transactions"; visualizations "relatively basic and mostly support the conversation". — [Craft Innovations](https://craftinnovations.global/revolut-air-ux-analysis/) (snippet)
- Uxcel heuristic evaluation of the Revolut mobile app exists (content not fetched). — [Uxcel showcase](https://app.uxcel.com/showcase/heuristic-evaluation-of-revolut-mobile-app-857)
- Apple: "Your purchase history. For your eyes. Not ours."; "See each purchase go through right away. No waiting. No wondering." — [Apple Card features](https://www.apple.com/apple-card/features/)
- Emma's redesign threads function as public design-feedback logs (Dec 2020 feed; multi-page "Emma 3.0 Designs" thread). — [Emma community](https://community.emma-app.com/t/new-feed-design-feedback/3335); [Emma 3.0 Designs](https://community.emma-app.com/t/emma-3-0-designs/5008?page=21)

### Inferences
- The richest "why" material is in help-centre explanations of a single hero metric (Copilot Free to Spend, Monarch Flex, Emma left-of) rather than in design write-ups; layout rationale must be inferred from help text and release notes.

### Gaps
- No Mobbin, Page Flows or growth.design case study on Copilot/Monarch/YNAB transaction lists was found via search; Mobbin's screenshot library is login-walled and was not queried directly.
- Bothrs' "Dissecting the app: Revolut" article now redirects to nimblestudio.com (content gone).
- The Simplifi community comparison is login-walled; only the snippet is available.
