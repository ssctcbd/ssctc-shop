-- SSCTC Shop — a staff member's own commission rate on a service or category.
--
-- Where a row exists it replaces the general rate for that person, from their
-- next sale on. A rate of zero means that person earns nothing on that item.
-- No row: the general rate on the service or category applies, as before.
--
-- Safe to run more than once, through `npm run migrate` or in phpMyAdmin.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE IF NOT EXISTS staff_commission_rates (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id           BIGINT UNSIGNED NOT NULL,
  service_id        BIGINT UNSIGNED NULL,
  category_id       BIGINT UNSIGNED NULL,
  commission_type   ENUM('percent','fixed') NOT NULL,
  commission_value  DECIMAL(10,2) NOT NULL,
  updated_by        BIGINT UNSIGNED NOT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_staff_rate_service (user_id, service_id),
  UNIQUE KEY uq_staff_rate_category (user_id, category_id),
  CONSTRAINT fk_staff_rate_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_staff_rate_service FOREIGN KEY (service_id) REFERENCES services (id),
  CONSTRAINT fk_staff_rate_category FOREIGN KEY (category_id) REFERENCES categories (id),
  CONSTRAINT fk_staff_rate_updated_by FOREIGN KEY (updated_by) REFERENCES users (id),
  CONSTRAINT ck_staff_rate_target CHECK ((service_id IS NULL) <> (category_id IS NULL)),
  CONSTRAINT ck_staff_rate_value CHECK (commission_value >= 0 AND (commission_type <> 'percent' OR commission_value <= 100))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
