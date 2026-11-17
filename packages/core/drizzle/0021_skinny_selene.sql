CREATE TABLE `push_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` integer NOT NULL,
	`type` text NOT NULL,
	`key` text NOT NULL,
	`text` text NOT NULL,
	`urgent` integer DEFAULT false NOT NULL,
	`otp_id` text,
	`created_at` text NOT NULL,
	`delivered_at` text
);
--> statement-breakpoint
ALTER TABLE `device` ADD `push_token` text;--> statement-breakpoint
ALTER TABLE `device` ADD `push_secret_hash` text;