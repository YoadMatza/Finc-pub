CREATE TABLE `security_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`kind` text NOT NULL,
	`actor` text NOT NULL,
	`actor_name` text,
	`address` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `security_event_kind` ON `security_event` (`kind`,`id`);
--> statement-breakpoint
CREATE TRIGGER `security_event_no_update` BEFORE UPDATE ON `security_event` BEGIN SELECT RAISE(ABORT, 'security_event is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `security_event_no_delete` BEFORE DELETE ON `security_event` BEGIN SELECT RAISE(ABORT, 'security_event is append-only'); END;