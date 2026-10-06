ALTER TABLE `bugs` ADD `scenario_id` text REFERENCES scenarios(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `bugs` ADD `test_case_id` text REFERENCES test_cases(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `bugs` ADD `failed_step_id` text;--> statement-breakpoint
ALTER TABLE `bugs` ADD `category` text;--> statement-breakpoint
ALTER TABLE `bugs` ADD `last_seen_at` text;