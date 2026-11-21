CREATE TABLE `security_trade` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`sync_run_id` integer,
	`first_seen_at` text NOT NULL,
	`row_key` text NOT NULL,
	`paper_id` text,
	`name` text,
	`symbol` text,
	`action` text NOT NULL,
	`action_text` text NOT NULL,
	`value_date` text NOT NULL,
	`quantity` real NOT NULL,
	`price` real NOT NULL,
	`currency` text NOT NULL,
	`gross` real NOT NULL,
	`net` real NOT NULL,
	`tax_il` real NOT NULL,
	`tax_abroad` real NOT NULL,
	`commission` real NOT NULL,
	`registration_date` text,
	`payment_date` text,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_trade_account_row` ON `security_trade` (`account_id`,`row_key`);--> statement-breakpoint
CREATE INDEX `security_trade_account_paper` ON `security_trade` (`account_id`,`paper_id`);