-- CreateTable
CREATE TABLE `users` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `email` VARCHAR(255) NOT NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `phone` VARCHAR(30) NULL,
    `platform_role` ENUM('USER', 'PLATFORM_ADMIN') NOT NULL DEFAULT 'USER',
    `status` ENUM('ACTIVE', 'SUSPENDED') NOT NULL DEFAULT 'ACTIVE',
    `language` VARCHAR(5) NOT NULL DEFAULT 'en',
    `theme` VARCHAR(10) NOT NULL DEFAULT 'system',
    `notification_prefs` JSON NULL,
    `last_login_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sessions` (
    `id` CHAR(64) NOT NULL,
    `user_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,
    `last_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `admin_until` DATETIME(3) NULL,
    `user_agent` VARCHAR(255) NULL,

    INDEX `sessions_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `portfolios` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(120) NOT NULL,
    `type` ENUM('GROUP', 'SOLO', 'MANAGED') NOT NULL DEFAULT 'GROUP',
    `status` ENUM('ACTIVE', 'SUSPENDED') NOT NULL DEFAULT 'ACTIVE',
    `contribution_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `due_day` TINYINT UNSIGNED NOT NULL DEFAULT 10,
    `grace_days` TINYINT UNSIGNED NOT NULL DEFAULT 0,
    `late_fee` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `initial_unit_price` DECIMAL(18, 6) NOT NULL DEFAULT 10,
    `start_month` CHAR(7) NOT NULL,
    `members_see_tracker` BOOLEAN NOT NULL DEFAULT false,
    `members_see_shares` BOOLEAN NOT NULL DEFAULT false,
    `payment_details` JSON NULL,
    `created_by_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `memberships` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `portfolio_id` INTEGER NOT NULL,
    `user_id` INTEGER NOT NULL,
    `role` ENUM('ADMIN', 'LEADER', 'MEMBER') NOT NULL DEFAULT 'MEMBER',
    `status` ENUM('ACTIVE', 'EXITED', 'REMOVED') NOT NULL DEFAULT 'ACTIVE',
    `joined_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `left_at` DATETIME(3) NULL,

    UNIQUE INDEX `memberships_portfolio_id_user_id_key`(`portfolio_id`, `user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invitations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `portfolio_id` INTEGER NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `role` ENUM('ADMIN', 'LEADER', 'MEMBER') NOT NULL DEFAULT 'MEMBER',
    `status` ENUM('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED') NOT NULL DEFAULT 'PENDING',
    `invited_by_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `responded_at` DATETIME(3) NULL,

    INDEX `invitations_email_status_idx`(`email`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `deposits` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `portfolio_id` INTEGER NOT NULL,
    `membership_id` INTEGER NOT NULL,
    `amount` DECIMAL(18, 4) NOT NULL,
    `period` CHAR(7) NOT NULL,
    `method` ENUM('BANK', 'ESEWA', 'KHALTI', 'CASH', 'OTHER') NOT NULL DEFAULT 'BANK',
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `reference` VARCHAR(120) NULL,
    `note` VARCHAR(500) NULL,
    `screenshot_path` VARCHAR(255) NULL,
    `screenshot_mime` VARCHAR(60) NULL,
    `rejection_reason` VARCHAR(500) NULL,
    `receipt_no` VARCHAR(40) NULL,
    `nav_at_approval` DECIMAL(18, 6) NULL,
    `units_issued` DECIMAL(20, 6) NULL,
    `submitted_by_id` INTEGER NOT NULL,
    `reviewed_by_id` INTEGER NULL,
    `submitted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reviewed_at` DATETIME(3) NULL,

    UNIQUE INDEX `deposits_receipt_no_key`(`receipt_no`),
    INDEX `deposits_portfolio_id_status_idx`(`portfolio_id`, `status`),
    INDEX `deposits_membership_id_period_idx`(`membership_id`, `period`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `holdings` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `portfolio_id` INTEGER NOT NULL,
    `asset_type` ENUM('STOCK', 'MUTUAL_FUND', 'BOND', 'FIXED_DEPOSIT', 'GOLD', 'REAL_ESTATE', 'CRYPTO', 'OTHER') NOT NULL,
    `symbol` VARCHAR(20) NULL,
    `name` VARCHAR(160) NOT NULL,
    `sector` VARCHAR(120) NULL,
    `current_price` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `price_source` ENUM('MANUAL', 'NEPSE') NOT NULL DEFAULT 'MANUAL',
    `price_updated_at` DATETIME(3) NULL,
    `notes` TEXT NULL,
    `archived` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `holdings_portfolio_id_idx`(`portfolio_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `holding_documents` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `holding_id` INTEGER NOT NULL,
    `file_name` VARCHAR(200) NOT NULL,
    `storage_path` VARCHAR(255) NOT NULL,
    `mime` VARCHAR(100) NOT NULL,
    `size` INTEGER UNSIGNED NOT NULL,
    `uploaded_by_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `portfolio_transactions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `portfolio_id` INTEGER NOT NULL,
    `type` ENUM('BUY', 'SELL', 'DIVIDEND', 'BONUS_SHARE', 'RIGHT_SHARE', 'FEE', 'WITHDRAWAL', 'DEPOSIT', 'EXIT_PAYOUT', 'ADJUSTMENT') NOT NULL,
    `status` ENUM('ACTIVE', 'REVERSED') NOT NULL DEFAULT 'ACTIVE',
    `holding_id` INTEGER NULL,
    `date` DATE NOT NULL,
    `quantity` DECIMAL(20, 6) NULL,
    `price` DECIMAL(18, 4) NULL,
    `amount` DECIMAL(18, 4) NULL,
    `fees` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `note` VARCHAR(500) NOT NULL,
    `deposit_id` INTEGER NULL,
    `exit_id` INTEGER NULL,
    `created_by_id` INTEGER NOT NULL,
    `reversed_at` DATETIME(3) NULL,
    `reverse_note` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `portfolio_transactions_deposit_id_key`(`deposit_id`),
    UNIQUE INDEX `portfolio_transactions_exit_id_key`(`exit_id`),
    INDEX `portfolio_transactions_portfolio_id_date_idx`(`portfolio_id`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `unit_entries` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `portfolio_id` INTEGER NOT NULL,
    `membership_id` INTEGER NOT NULL,
    `kind` ENUM('ISSUE', 'REDEEM') NOT NULL,
    `units` DECIMAL(20, 6) NOT NULL,
    `nav` DECIMAL(18, 6) NOT NULL,
    `amount` DECIMAL(18, 4) NOT NULL,
    `deposit_id` INTEGER NULL,
    `exit_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `unit_entries_deposit_id_key`(`deposit_id`),
    UNIQUE INDEX `unit_entries_exit_id_key`(`exit_id`),
    INDEX `unit_entries_membership_id_idx`(`membership_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `nav_snapshots` (
    `portfolio_id` INTEGER NOT NULL,
    `date` DATE NOT NULL,
    `nav_per_unit` DECIMAL(18, 6) NOT NULL,
    `total_value` DECIMAL(18, 4) NOT NULL,
    `cash` DECIMAL(18, 4) NOT NULL,
    `invested` DECIMAL(18, 4) NOT NULL,
    `total_units` DECIMAL(20, 6) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`portfolio_id`, `date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `exit_requests` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `portfolio_id` INTEGER NOT NULL,
    `membership_id` INTEGER NOT NULL,
    `status` ENUM('REQUESTED', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'REQUESTED',
    `reason` VARCHAR(500) NULL,
    `nav_at_approval` DECIMAL(18, 6) NULL,
    `units` DECIMAL(20, 6) NULL,
    `payout_amount` DECIMAL(18, 4) NULL,
    `paid_reference` VARCHAR(120) NULL,
    `rejection_reason` VARCHAR(500) NULL,
    `requested_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `approved_at` DATETIME(3) NULL,
    `paid_at` DATETIME(3) NULL,
    `decided_by_id` INTEGER NULL,

    INDEX `exit_requests_portfolio_id_status_idx`(`portfolio_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cash_accounts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `portfolio_id` INTEGER NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `kind` ENUM('BANK', 'BROKER', 'ESEWA', 'CASH', 'OTHER') NOT NULL,
    `account_ref` VARCHAR(120) NULL,
    `balance` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `balance_as_of` DATE NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cash_reconciliations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `portfolio_id` INTEGER NOT NULL,
    `date` DATE NOT NULL,
    `book_balance` DECIMAL(18, 4) NOT NULL,
    `reported_balance` DECIMAL(18, 4) NOT NULL,
    `difference` DECIMAL(18, 4) NOT NULL,
    `adjustment_tx_id` INTEGER NULL,
    `note` VARCHAR(500) NOT NULL,
    `created_by_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifications` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `portfolio_id` INTEGER NULL,
    `type` ENUM('PAYMENT_DUE', 'DEPOSIT_APPROVED', 'DEPOSIT_REJECTED', 'NEW_TRADE', 'EXIT_UPDATE', 'INVITATION', 'GENERAL') NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `body` VARCHAR(500) NULL,
    `link` VARCHAR(255) NULL,
    `read_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notifications_user_id_read_at_idx`(`user_id`, `read_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `portfolio_id` INTEGER NULL,
    `actor_id` INTEGER NULL,
    `actor_name` VARCHAR(120) NULL,
    `action` VARCHAR(60) NOT NULL,
    `entity_type` VARCHAR(40) NULL,
    `entity_id` VARCHAR(40) NULL,
    `summary` VARCHAR(500) NOT NULL,
    `data` JSON NULL,
    `ip` VARCHAR(64) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_portfolio_id_created_at_idx`(`portfolio_id`, `created_at`),
    INDEX `audit_logs_actor_id_idx`(`actor_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `abuse_reports` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `reporter_id` INTEGER NOT NULL,
    `portfolio_id` INTEGER NULL,
    `reported_user_id` INTEGER NULL,
    `reason` VARCHAR(120) NOT NULL,
    `details` TEXT NULL,
    `status` ENUM('OPEN', 'RESOLVED', 'DISMISSED') NOT NULL DEFAULT 'OPEN',
    `resolution_note` VARCHAR(500) NULL,
    `resolved_by_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolved_at` DATETIME(3) NULL,

    INDEX `abuse_reports_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `memberships` ADD CONSTRAINT `memberships_portfolio_id_fkey` FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `memberships` ADD CONSTRAINT `memberships_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invitations` ADD CONSTRAINT `invitations_portfolio_id_fkey` FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `deposits` ADD CONSTRAINT `deposits_portfolio_id_fkey` FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `deposits` ADD CONSTRAINT `deposits_membership_id_fkey` FOREIGN KEY (`membership_id`) REFERENCES `memberships`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `holdings` ADD CONSTRAINT `holdings_portfolio_id_fkey` FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `holding_documents` ADD CONSTRAINT `holding_documents_holding_id_fkey` FOREIGN KEY (`holding_id`) REFERENCES `holdings`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `portfolio_transactions` ADD CONSTRAINT `portfolio_transactions_portfolio_id_fkey` FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `portfolio_transactions` ADD CONSTRAINT `portfolio_transactions_holding_id_fkey` FOREIGN KEY (`holding_id`) REFERENCES `holdings`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `unit_entries` ADD CONSTRAINT `unit_entries_portfolio_id_fkey` FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `unit_entries` ADD CONSTRAINT `unit_entries_membership_id_fkey` FOREIGN KEY (`membership_id`) REFERENCES `memberships`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `nav_snapshots` ADD CONSTRAINT `nav_snapshots_portfolio_id_fkey` FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `exit_requests` ADD CONSTRAINT `exit_requests_portfolio_id_fkey` FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `exit_requests` ADD CONSTRAINT `exit_requests_membership_id_fkey` FOREIGN KEY (`membership_id`) REFERENCES `memberships`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cash_accounts` ADD CONSTRAINT `cash_accounts_portfolio_id_fkey` FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cash_reconciliations` ADD CONSTRAINT `cash_reconciliations_portfolio_id_fkey` FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


-- The audit log is append-only: reject every UPDATE and DELETE, even from the app's own DB user.
CREATE TRIGGER `audit_logs_no_update` BEFORE UPDATE ON `audit_logs` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';

CREATE TRIGGER `audit_logs_no_delete` BEFORE DELETE ON `audit_logs` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';
