ALTER TABLE `mail_inboxes` ADD `name` text DEFAULT 'Inbox' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `mail_inboxes_app_name_uq` ON `mail_inboxes` (`application_id`,`name`);