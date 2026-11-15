CREATE TABLE `txn_fingerprint` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`transaction_id` integer NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transaction`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `txn_fingerprint_txn` ON `txn_fingerprint` (`transaction_id`);