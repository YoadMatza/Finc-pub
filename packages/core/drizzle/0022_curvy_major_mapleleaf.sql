CREATE TABLE `cost_lot_snapshot` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`sync_run_id` integer,
	`taken_at` text NOT NULL,
	`paper_id` text NOT NULL,
	`name` text NOT NULL,
	`action` text NOT NULL,
	`action_text` text NOT NULL,
	`quantity` real NOT NULL,
	`cost_price` real NOT NULL,
	`cost_price_ils` real NOT NULL,
	`currency` text NOT NULL,
	`trade_date` text NOT NULL,
	`avg_price` real,
	`last_price` real,
	`change_pct` real,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cost_lot_snapshot_account_taken` ON `cost_lot_snapshot` (`account_id`,`taken_at`);--> statement-breakpoint
CREATE TABLE `tax_year_summary` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`year` integer NOT NULL,
	`taken_at` text NOT NULL,
	`losses_ils` integer NOT NULL,
	`gains_json` text NOT NULL,
	`tax_withheld_json` text NOT NULL,
	`interest_dividend_ils` integer,
	`interest_dividend_tax_ils` integer,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_year_summary_account_year` ON `tax_year_summary` (`account_id`,`year`);