CREATE TABLE `category` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name_he` text NOT NULL,
	`name_en` text NOT NULL,
	`group_key` text NOT NULL,
	`section` text NOT NULL,
	`parent_id` integer,
	`monthly_target` integer,
	`track` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`icon` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `category_key` ON `category` (`key`);--> statement-breakpoint
CREATE TABLE `recurring_stream` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`merchant_id` integer NOT NULL,
	`category_id` integer,
	`frequency` text NOT NULL,
	`expected_amount` integer NOT NULL,
	`amount_tolerance` integer NOT NULL,
	`amount_model` text NOT NULL,
	`original_currency` text,
	`expected_original_amount` integer,
	`expected_day` integer,
	`next_expected_date` text,
	`last_txn_date` text,
	`last_txn_id` integer,
	`occurrences` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'candidate' NOT NULL,
	`state_source` text DEFAULT 'auto' NOT NULL,
	`direction` text NOT NULL,
	`label` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recurring_stream_merchant` ON `recurring_stream` (`merchant_id`);--> statement-breakpoint
CREATE TABLE `rule` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`conditions_json` text NOT NULL,
	`actions_json` text NOT NULL,
	`created_from_txn_id` integer,
	`note` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `transaction` ADD `category_confidence` real;--> statement-breakpoint
ALTER TABLE `transaction` ADD `recurring_stream_id` integer;