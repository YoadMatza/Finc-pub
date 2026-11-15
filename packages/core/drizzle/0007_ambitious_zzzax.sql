CREATE TABLE `alert_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`key` text NOT NULL,
	`channel` text NOT NULL,
	`text` text NOT NULL,
	`ok` integer NOT NULL,
	`error` text,
	`sent_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_log_key_channel` ON `alert_log` (`key`,`channel`);--> statement-breakpoint
CREATE INDEX `alert_log_sent` ON `alert_log` (`sent_at`);