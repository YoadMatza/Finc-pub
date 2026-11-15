CREATE TABLE `holding_snapshot` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`sync_run_id` integer,
	`taken_at` text NOT NULL,
	`kind` text NOT NULL,
	`symbol` text NOT NULL,
	`name` text NOT NULL,
	`quantity` real NOT NULL,
	`price` real,
	`currency` text DEFAULT 'ILS' NOT NULL,
	`value_ils` integer NOT NULL,
	`value_orig` real,
	`cost_price` real,
	`daily_change_pct` real,
	`from_cost_pct` real,
	`source` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `holding_snapshot_account_taken` ON `holding_snapshot` (`account_id`,`taken_at`);