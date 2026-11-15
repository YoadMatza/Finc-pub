CREATE TABLE `holding_rule` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`template` text NOT NULL,
	`params` text NOT NULL,
	`scope_symbol` text,
	`notify` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `holding_rule_state` (
	`rule_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`state` text NOT NULL,
	`since` text,
	`last_value` real,
	`last_known_state` text,
	`last_known_at` text,
	`last_evaluated_at` text NOT NULL,
	`last_notified_at` text,
	PRIMARY KEY(`rule_id`, `symbol`),
	FOREIGN KEY (`rule_id`) REFERENCES `holding_rule`(`id`) ON UPDATE no action ON DELETE cascade
);
