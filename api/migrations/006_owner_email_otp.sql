-- SSCTC Shop — forgot password by a one-time code sent to the Owner's email.
--
-- 1. users.email: where an Owner's code goes. Set on the Password screen.
-- 2. owner_password_otps: the codes. Only a hash is stored; a code lasts ten
--    minutes, allows five tries and works once.
--
-- Every change checks information_schema first, so the file can be run more
-- than once, through `npm run migrate` or pasted into phpMyAdmin.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'email') = 0,
  'ALTER TABLE users ADD COLUMN email VARCHAR(190) NULL AFTER phone', 'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS owner_password_otps (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  code_hash   CHAR(64) NOT NULL,
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL,
  ip          VARCHAR(45) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_otp_user (user_id, id),
  CONSTRAINT fk_otp_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
