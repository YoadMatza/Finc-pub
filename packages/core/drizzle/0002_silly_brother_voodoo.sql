CREATE TABLE `counterparty_rule` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pattern` text NOT NULL,
	`kind` text NOT NULL,
	`account_id` integer,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `installment_plan` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`merchant_id` integer,
	`plan_key` text NOT NULL,
	`total_n` integer NOT NULL,
	`original_amount` integer,
	`slice_amount` integer,
	`first_date` text NOT NULL,
	`seen_n` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `installment_plan_key` ON `installment_plan` (`account_id`,`plan_key`);--> statement-breakpoint
CREATE TABLE `link` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`from_txn_id` integer NOT NULL,
	`to_txn_id` integer NOT NULL,
	`amount` integer NOT NULL,
	`confidence` real NOT NULL,
	`zone` text NOT NULL,
	`source` text NOT NULL,
	`explanation_json` text NOT NULL,
	`decision` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`from_txn_id`) REFERENCES `transaction`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_txn_id`) REFERENCES `transaction`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `link_from` ON `link` (`from_txn_id`);--> statement-breakpoint
CREATE INDEX `link_to` ON `link` (`to_txn_id`);--> statement-breakpoint
CREATE INDEX `link_type` ON `link` (`type`);--> statement-breakpoint
CREATE TABLE `merchant` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`aliases_json` text DEFAULT '[]' NOT NULL,
	`external_ids_json` text DEFAULT '{}' NOT NULL,
	`default_category_id` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_key` ON `merchant` (`key`);--> statement-breakpoint
ALTER TABLE `transaction` ADD `merchant_id` integer;--> statement-breakpoint
ALTER TABLE `transaction` ADD `installment_plan_id` integer;