CREATE TABLE `forecast_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`month` text NOT NULL,
	`date` text NOT NULL,
	`day` integer NOT NULL,
	`left_to_spend` integer NOT NULL,
	`room_before_variable` integer NOT NULL,
	`variable_spent` integer NOT NULL,
	`predicted_variable` integer NOT NULL,
	`projected_end` integer NOT NULL,
	`band_lo` integer NOT NULL,
	`band_hi` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forecast_log_date_unique` ON `forecast_log` (`date`);--> statement-breakpoint
CREATE INDEX `forecast_log_month` ON `forecast_log` (`month`);