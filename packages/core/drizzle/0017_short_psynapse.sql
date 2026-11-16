CREATE TABLE `txn_split` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`txn_id` integer NOT NULL,
	`category_id` integer NOT NULL,
	`amount` integer NOT NULL,
	`sort` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`txn_id`) REFERENCES `transaction`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `category`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `txn_split_txn` ON `txn_split` (`txn_id`);