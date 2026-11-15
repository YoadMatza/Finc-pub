CREATE TABLE `ai_suggestion` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`merchant_id` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`category_id` integer,
	`confidence` real NOT NULL,
	`reason` text,
	`sent_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_suggestion_merchant` ON `ai_suggestion` (`merchant_id`);--> statement-breakpoint
CREATE TABLE `setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
