CREATE TABLE `event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`note` text,
	`from_date` text,
	`to_date` text,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_txn` (
	`event_id` integer NOT NULL,
	`txn_id` integer NOT NULL,
	`added_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`txn_id`) REFERENCES `transaction`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_txn_unique` ON `event_txn` (`event_id`,`txn_id`);--> statement-breakpoint
CREATE INDEX `event_txn_txn` ON `event_txn` (`txn_id`);