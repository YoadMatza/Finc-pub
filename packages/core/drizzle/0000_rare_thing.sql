CREATE TABLE `account` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`institution_id` text NOT NULL,
	`type` text NOT NULL,
	`display_name` text,
	`last4` text,
	`currency` text DEFAULT 'ILS' NOT NULL,
	`billing_day` integer,
	`settles_to_account_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`institution_id`) REFERENCES `institution`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `account_alias` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_alias_source_external` ON `account_alias` (`source`,`external_id`);--> statement-breakpoint
CREATE TABLE `balance_snapshot` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`sync_run_id` integer,
	`taken_at` text NOT NULL,
	`balance` integer NOT NULL,
	`source` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `balance_snapshot_account_taken` ON `balance_snapshot` (`account_id`,`taken_at`);--> statement-breakpoint
CREATE TABLE `connection` (
	`institution_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_ok_at` text,
	`last_error` text,
	`last_error_at` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`next_run_at` text,
	`last_run_id` integer,
	FOREIGN KEY (`institution_id`) REFERENCES `institution`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `institution` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`scraper_id` text,
	`display_name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `raw_transaction` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`source` text NOT NULL,
	`source_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`first_seen_run_id` integer,
	`last_seen_run_id` integer,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `raw_transaction_source_hash` ON `raw_transaction` (`source_hash`);--> statement-breakpoint
CREATE INDEX `raw_transaction_account` ON `raw_transaction` (`account_id`);--> statement-breakpoint
CREATE TABLE `sync_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`institution_id` text NOT NULL,
	`source` text NOT NULL,
	`trigger` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`status` text NOT NULL,
	`rows_seen` integer DEFAULT 0 NOT NULL,
	`rows_new` integer DEFAULT 0 NOT NULL,
	`rows_updated` integer DEFAULT 0 NOT NULL,
	`rows_completed` integer DEFAULT 0 NOT NULL,
	`rows_voided` integer DEFAULT 0 NOT NULL,
	`rows_annotated` integer DEFAULT 0 NOT NULL,
	`error_type` text,
	`error` text,
	`meta_json` text
);
--> statement-breakpoint
CREATE INDEX `sync_run_institution_started` ON `sync_run` (`institution_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `transaction` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`raw_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`source` text NOT NULL,
	`fingerprint` text NOT NULL,
	`txn_date` text NOT NULL,
	`charge_date` text,
	`cashflow_month` text NOT NULL,
	`amount_ils` integer NOT NULL,
	`original_amount` integer,
	`original_currency` text DEFAULT 'ILS' NOT NULL,
	`description_raw` text NOT NULL,
	`description_norm` text NOT NULL,
	`memo` text,
	`identifier` text,
	`status` text NOT NULL,
	`txn_type` text NOT NULL,
	`installment_n` integer,
	`installment_total` integer,
	`kind` text,
	`category_id` integer,
	`category_source` text,
	`excluded` integer DEFAULT false NOT NULL,
	`note` text,
	`annotations_json` text,
	`completed_at` text,
	`voided_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`raw_id`) REFERENCES `raw_transaction`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transaction_fingerprint` ON `transaction` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `transaction_account_date` ON `transaction` (`account_id`,`txn_date`);--> statement-breakpoint
CREATE INDEX `transaction_status` ON `transaction` (`status`);--> statement-breakpoint
CREATE INDEX `transaction_month` ON `transaction` (`cashflow_month`);