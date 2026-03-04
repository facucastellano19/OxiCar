-- =========================================
-- ROLES
-- =========================================
CREATE TABLE roles (
    id TINYINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL
);

-- Insert initial roles
INSERT INTO roles (name) VALUES ('admin'), ('employee');

-- =========================================
-- USERS
-- =========================================
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role_id TINYINT NOT NULL DEFAULT 2, -- 1 = admin, 2 = employee 
    FOREIGN KEY (role_id) REFERENCES roles(id),

    -- Audit fields
    created_at DATETIME NULL,
    updated_at DATETIME NULL,
    deleted_at DATETIME NULL,
    created_by INT NULL,
    updated_by INT NULL,
    deleted_by INT NULL
);

-- =========================================
-- AUDIT LOG
-- =========================================
CREATE TABLE audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,                          -- Who performed the action (can be NULL for system actions)
    username VARCHAR(50),                 -- The username of the user who performed the action
    action_type VARCHAR(50) NOT NULL,     -- What was the action (e.g., 'CREATE', 'UPDATE', 'LOGIN_SUCCESS')
    entity_type VARCHAR(50),              -- On which table/entity (e.g., 'product', 'client')
    entity_id INT,                        -- The ID of the affected record
    changes JSON,                         -- A JSON object detailing what changed (e.g., { "old": { "price": 10 }, "new": { "price": 12 } })
    status ENUM('SUCCESS', 'FAILURE') NOT NULL DEFAULT 'SUCCESS', -- Was the action successful?
    error_message TEXT,                   -- If it failed, what was the error?
    ip_address VARCHAR(45),               -- IP address of the user
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- =========================================
-- Clients
-- =========================================
CREATE TABLE clients (
    id INT AUTO_INCREMENT PRIMARY KEY,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE,
    phone VARCHAR(50) UNIQUE,

    -- Audit fields
    created_at DATETIME NULL,
    updated_at DATETIME NULL,
    created_by INT NULL,
    updated_by INT NULL
);


-- =========================================
-- VEHICLES
-- =========================================
CREATE TABLE vehicles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    client_id INT NOT NULL,
    brand VARCHAR(50),
    model VARCHAR(50),
    year INT,
    color VARCHAR(50),
    license_plate VARCHAR(20),

    -- Audit fields
    created_at DATETIME NULL,
    updated_at DATETIME NULL,
    deleted_at DATETIME NULL,
    created_by INT NULL,
    updated_by INT NULL,
    deleted_by INT NULL,

    CONSTRAINT fk_vehicle_client FOREIGN KEY (client_id) REFERENCES clients(id)
);


-- =========================================
-- SERVICE CATEGORIES
-- =========================================
CREATE TABLE service_categories (
    id TINYINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL, -- Example: Treatments, Cleanings, Others
    -- Audit fields
    created_at DATETIME NULL,
    updated_at DATETIME NULL,
    deleted_at DATETIME NULL,
    created_by INT NULL,
    updated_by INT NULL,
    deleted_by INT NULL
);

-- =========================================
-- SERVICES
-- =========================================
CREATE TABLE services (
    id INT AUTO_INCREMENT PRIMARY KEY,
    category_id TINYINT NOT NULL,
    name VARCHAR(100) NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    -- Audit fields
    created_at DATETIME NULL,
    updated_at DATETIME NULL,
    deleted_at DATETIME NULL,
    created_by INT NULL,
    updated_by INT NULL,
    deleted_by INT NULL,
    CONSTRAINT fk_service_category FOREIGN KEY (category_id) REFERENCES service_categories(id)
);

-- =========================================
-- PAYMENT STATUS
-- =========================================
CREATE TABLE payment_status (
    id TINYINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);

INSERT INTO payment_status (name)
VALUES ('Pendiente'), ('Pagado'), ('Cancelado');

-- =========================================
-- PAYMENT METHODS
-- =========================================
CREATE TABLE payment_methods (
    id TINYINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);

INSERT INTO payment_methods (name)
VALUES ('Efectivo'), ('Transferencia');

-- =========================================
-- SERVICE STATUS
-- =========================================
CREATE TABLE service_status (
    id TINYINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);

INSERT INTO service_status (name)
VALUES ('Pendiente'), ('En proceso'), ('Completado'),('Cancelado');

-- =========================================
-- SALE TYPES
-- =========================================
CREATE TABLE sale_types (
    id TINYINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);

INSERT INTO sale_types (name)
VALUES ('Servicio'), ('Producto');

-- =========================================
-- Product Categories
-- =========================================
CREATE TABLE product_categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,

    -- Audit fields
    created_at DATETIME NULL,
    updated_at DATETIME NULL,
    deleted_at DATETIME NULL,
    created_by INT NULL,
    updated_by INT NULL,
    deleted_by INT NULL
);

-- =========================================
-- PRODUCTS
-- =========================================
CREATE TABLE products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    stock INT NOT NULL DEFAULT 0,
    category_id INT NOT NULL,
    min_stock INT NOT NULL DEFAULT 0,

    created_at DATETIME NULL,
    updated_at DATETIME NULL,
    deleted_at DATETIME NULL,
    created_by INT NULL,
    updated_by INT NULL,
    deleted_by INT NULL,

    CONSTRAINT fk_products_category
        FOREIGN KEY (category_id) REFERENCES product_categories(id)
);

-- =========================================
-- SALES
-- =========================================
CREATE TABLE sales (
    id INT AUTO_INCREMENT PRIMARY KEY,
    client_id INT NOT NULL,
    vehicle_id INT NULL,
    sale_type_id TINYINT NOT NULL,         -- 1 = Service, 2 = Product
    service_status_id TINYINT NOT NULL DEFAULT 1,  -- Pending
    payment_status_id TINYINT NOT NULL DEFAULT 1,  -- Pending
    payment_method_id TINYINT NOT NULL,
    total DECIMAL(12,2) NOT NULL DEFAULT 0,
    observations TEXT,

    -- Audit fields
    created_at DATETIME NULL,
    updated_at DATETIME NULL,
    deleted_at DATETIME NULL,
    created_by INT NULL,
    updated_by INT NULL,
    deleted_by INT NULL,

    -- Service Timestamps 
    started_at DATETIME NULL,
    completed_at DATETIME NULL,
    cancelled_at DATETIME NULL,
    
    -- Payment Timestamps 
    paid_at DATETIME NULL,
    payment_cancelled_at DATETIME NULL,  

    FOREIGN KEY (client_id) REFERENCES clients(id),
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id),
    FOREIGN KEY (sale_type_id) REFERENCES sale_types(id),
    FOREIGN KEY (service_status_id) REFERENCES service_status(id),
    FOREIGN KEY (payment_status_id) REFERENCES payment_status(id),
    FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id)
);

-- =========================================
-- SALE_SERVICES
-- =========================================
CREATE TABLE sale_services (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sale_id INT NOT NULL,
    service_id INT NOT NULL,
    price DECIMAL(10,2) NOT NULL,

    -- Audit fields
    created_at DATETIME NULL,
    updated_at DATETIME NULL,
    deleted_at DATETIME NULL,
    created_by INT NULL,
    updated_by INT NULL,
    deleted_by INT NULL,

    FOREIGN KEY (sale_id) REFERENCES sales(id),
    FOREIGN KEY (service_id) REFERENCES services(id)
);

-- =========================================
-- SALE_PRODUCTS
-- =========================================
CREATE TABLE sale_products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sale_id INT NOT NULL,
    product_id INT NOT NULL,
    quantity INT NOT NULL DEFAULT 1,
    price DECIMAL(10,2) NOT NULL,
    subtotal DECIMAL(12,2) GENERATED ALWAYS AS (quantity * price) STORED,

    -- Audit fields
    created_at DATETIME NULL,
    updated_at DATETIME NULL,
    deleted_at DATETIME NULL,
    created_by INT NULL,
    updated_by INT NULL,
    deleted_by INT NULL,

    FOREIGN KEY (sale_id) REFERENCES sales(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
);

-- =========================================
-- STORED PROCEDURE: sp_dashboard_metrics
-- =========================================
DROP PROCEDURE IF EXISTS sp_dashboard_metrics;
DELIMITER $$

CREATE PROCEDURE sp_dashboard_metrics(
    IN in_start_date DATETIME,
    IN in_end_date DATETIME,
    IN in_breakdown_type ENUM('daily','monthly')
)
BEGIN
    -- General metrics (totals)
    SELECT 
        COALESCE(SUM(s.total), 0) AS totalRevenue,
        COALESCE(SUM(CASE WHEN s.sale_type_id = 2 THEN s.total ELSE 0 END), 0) AS totalProductRevenue,
        COALESCE(SUM(CASE WHEN s.sale_type_id = 1 THEN s.total ELSE 0 END), 0) AS totalServiceRevenue,
        COALESCE(COUNT(DISTINCT s.client_id), 0) AS totalClientsAttended
    FROM sales s
    WHERE s.deleted_at IS NULL
      AND s.payment_status_id = 2
      AND s.created_at BETWEEN in_start_date AND in_end_date;

    -- Breakdown (daily or monthly)
    IF in_breakdown_type = 'daily' THEN
        SELECT
            DATE(s.created_at) AS breakdown_key,
            COALESCE(SUM(CASE WHEN s.sale_type_id = 1 THEN 1 ELSE 0 END), 0) AS service_count,
            COALESCE(SUM(CASE WHEN s.sale_type_id = 2 THEN 1 ELSE 0 END), 0) AS product_count,
            COALESCE(SUM(CASE WHEN s.sale_type_id = 1 THEN s.total ELSE 0 END), 0) AS service_revenue,
            COALESCE(SUM(CASE WHEN s.sale_type_id = 2 THEN s.total ELSE 0 END), 0) AS product_revenue
        FROM sales s
        WHERE s.deleted_at IS NULL
          AND s.payment_status_id = 2
          AND s.created_at BETWEEN in_start_date AND in_end_date
        GROUP BY breakdown_key
        ORDER BY breakdown_key;
    ELSE
        SELECT
            DATE_FORMAT(s.created_at, '%Y-%m') AS breakdown_key,
            COALESCE(SUM(CASE WHEN s.sale_type_id = 1 THEN 1 ELSE 0 END), 0) AS service_count,
            COALESCE(SUM(CASE WHEN s.sale_type_id = 2 THEN 1 ELSE 0 END), 0) AS product_count,
            COALESCE(SUM(CASE WHEN s.sale_type_id = 1 THEN s.total ELSE 0 END), 0) AS service_revenue,
            COALESCE(SUM(CASE WHEN s.sale_type_id = 2 THEN s.total ELSE 0 END), 0) AS product_revenue
        FROM sales s
        WHERE s.deleted_at IS NULL
          AND s.payment_status_id = 2
          AND s.created_at BETWEEN in_start_date AND in_end_date
        GROUP BY DATE_FORMAT(s.created_at, '%Y-%m')
        ORDER BY breakdown_key;
    END IF;

    -- Top 5 products
    SELECT 
        p.name AS product,
        COALESCE(SUM(sp.quantity), 0) AS quantity
    FROM sale_products sp
    JOIN products p ON p.id = sp.product_id
    JOIN sales s ON s.id = sp.sale_id
    WHERE s.deleted_at IS NULL
      AND s.payment_status_id = 2
      AND s.created_at BETWEEN in_start_date AND in_end_date
    GROUP BY p.name
    HAVING quantity > 0
    ORDER BY quantity DESC
    LIMIT 5;

    -- Top 5 services
    SELECT 
        sv.name AS service,
        COUNT(sv.id) AS quantity
    FROM sale_services ss
    JOIN services sv ON sv.id = ss.service_id
    JOIN sales s ON s.id = ss.sale_id
    WHERE s.deleted_at IS NULL
      AND s.payment_status_id = 2
      AND s.created_at BETWEEN in_start_date AND in_end_date
    GROUP BY sv.name
    HAVING quantity > 0
    ORDER BY quantity DESC
    LIMIT 5;

    -- Top 5 clients
    SELECT 
        CONCAT(c.first_name, ' ', c.last_name) AS client,
        COALESCE(SUM(s.total), 0) AS total
    FROM sales s
    JOIN clients c ON c.id = s.client_id
    WHERE s.deleted_at IS NULL
      AND s.payment_status_id = 2
      AND s.created_at BETWEEN in_start_date AND in_end_date
    GROUP BY c.id
    HAVING total > 0
    ORDER BY total DESC
    LIMIT 5;

    -- Revenue by payment method
    SELECT 
        pm.name AS method,
        COALESCE(SUM(s.total), 0) AS total
    FROM payment_methods pm
    LEFT JOIN sales s ON pm.id = s.payment_method_id
        AND s.deleted_at IS NULL
        AND s.payment_status_id = 2
        AND s.created_at BETWEEN in_start_date AND in_end_date
    GROUP BY pm.name
    ORDER BY pm.id;
END$$

DELIMITER ;

-- =========================================
-- STORED PROCEDURE: sp_home_dashboard
-- =========================================
DROP PROCEDURE IF EXISTS sp_home_dashboard;
DELIMITER $$

CREATE PROCEDURE sp_home_dashboard()
BEGIN
    -- Define the range for the last 7 days
    SET @endDate = NOW();
    SET @startDate = DATE_SUB(@endDate, INTERVAL 7 DAY);

    -- 1. Summary metrics (last 7 days)
    SELECT
        COUNT(s.id) AS totalSales,
        COALESCE(SUM(CASE WHEN s.payment_status_id = 2 THEN 1 ELSE 0 END), 0) AS confirmedPayments,
        COALESCE(SUM(CASE WHEN s.payment_status_id = 1 THEN 1 ELSE 0 END), 0) AS pendingPayments
    FROM sales s
    WHERE s.deleted_at IS NULL
      AND s.created_at BETWEEN @startDate AND @endDate;

    -- 2. Recent service activity (last 5 service sales)
    SELECT
        s.id AS sale_id,
        CONCAT(c.first_name, ' ', c.last_name) AS client_name,
        TIME(s.created_at) AS sale_time,
        s.total AS sale_total,
        ss_status.name AS service_status,
        GROUP_CONCAT(sv.name SEPARATOR ', ') AS services -- Group service names
    FROM (
        -- Subquery to get the last 5 service sales
        SELECT * FROM sales
        WHERE sale_type_id = 1 AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT 5
    ) AS s
    JOIN clients c ON s.client_id = c.id
    JOIN service_status ss_status ON s.service_status_id = ss_status.id
    JOIN sale_services ss ON s.id = ss.sale_id
    JOIN services sv ON ss.service_id = sv.id
    GROUP BY s.id, client_name, sale_time, sale_total, service_status
    ORDER BY s.created_at DESC;


    -- 3. Recent product activity (last 5 product sales)
    -- First, we get the main sales
    SELECT
        s.id AS sale_id,
        CONCAT(c.first_name, ' ', c.last_name) AS client_name,
        TIME(s.created_at) AS sale_time,
        s.total AS sale_total,
        ps.name AS payment_status
    FROM sales s
    JOIN clients c ON s.client_id = c.id
    JOIN payment_status ps ON s.payment_status_id = ps.id
    WHERE s.sale_type_id = 2 AND s.deleted_at IS NULL
    ORDER BY s.created_at DESC
    LIMIT 5;

    -- 4. Detailed products for those recent product sales
    SELECT
        sp.sale_id,
        p.name AS product_name,
        sp.quantity,
        sp.price AS unit_price,
        sp.subtotal
    FROM sale_products sp
    JOIN products p ON sp.product_id = p.id
    WHERE sp.sale_id IN ( -- We use a derived table to bypass the "LIMIT in subquery" restriction
        SELECT sale_id FROM (
            -- We ensure that we only bring products from the 5 most recent product sales
            SELECT id AS sale_id
            FROM sales
            WHERE sale_type_id = 2 AND deleted_at IS NULL
            ORDER BY created_at DESC
            LIMIT 5
        ) AS recent_sales
    );

END$$

DELIMITER ;