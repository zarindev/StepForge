ALTER TABLE `run_items` ADD `scenario_id` text REFERENCES scenarios(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `run_items` ADD `label_json` text;--> statement-breakpoint
ALTER TABLE `run_items` ADD `position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `run_items_scenario_idx` ON `run_items` (`scenario_id`);--> statement-breakpoint
ALTER TABLE `runs` ADD `options_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `step_results` ADD `type` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `step_results` ADD `label` text DEFAULT '' NOT NULL;