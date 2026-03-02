const getConnection = require("../database/mysql");
const auditLogService = require("./auditLogService");

class SalesService {
  async getSalesProducts(params = {}) {
    let connection;
    try {
      connection = await getConnection();
      const { clientName, startDate, endDate, paymentStatusId } = params;

      let query = `
                SELECT 
                    s.id AS sale_id,
                    CONCAT(c.first_name, ' ', c.last_name) AS client_name,
                    p.id AS product_id,
                    p.name AS product_name,
                    sp.quantity,
                    sp.price,
                    sp.subtotal,
                    s.total AS sale_total,
                    pm.name AS payment_method,
                    ps.name AS payment_status,
                    s.created_at,
                    s.observations
                FROM sales s
                JOIN clients c ON s.client_id = c.id
                JOIN sale_products sp ON sp.sale_id = s.id
                JOIN products p ON p.id = sp.product_id
                JOIN payment_methods pm ON s.payment_method_id = pm.id
                JOIN payment_status ps ON s.payment_status_id = ps.id
                WHERE s.sale_type_id = 2
                  AND s.deleted_at IS NULL`;

      const queryParams = [];

      if (clientName) {
        query += ` AND CONCAT(c.first_name, ' ', c.last_name) LIKE ?`;
        queryParams.push(`%${clientName}%`);
      }

      if (startDate) {
        query += ` AND s.created_at >= ?`;
        queryParams.push(startDate);
      }

      if (endDate) {
        query += ` AND s.created_at <= ?`;
        queryParams.push(`${endDate} 23:59:59`); // Include the whole day
      }

      if (paymentStatusId) {
        query += ` AND s.payment_status_id = ?`;
        queryParams.push(paymentStatusId);
      }

      query += ` ORDER BY s.created_at DESC, s.id DESC`;

      const [salesProducts] = await connection.query(query, queryParams);

      const salesMap = new Map();

      salesProducts.forEach((row) => {
        if (!salesMap.has(row.sale_id)) {
          salesMap.set(row.sale_id, {
            sale_id: row.sale_id,
            client_name: row.client_name,
            sale_total: row.sale_total,
            payment_method: row.payment_method,
            payment_status: row.payment_status,
            observations: row.observations,
            created_at: row.created_at,
            started_at: row.started_at,
            completed_at: row.completed_at,
            cancelled_at: row.cancelled_at,
            products: [],
          });
        }

        salesMap.get(row.sale_id).products.push({
          product_id: row.product_id,
          product_name: row.product_name,
          quantity: row.quantity,
          price: row.price,
          subtotal: row.subtotal,
        });
      });

      return {
        message: "Sales products retrieved successfully",
        data: Array.from(salesMap.values()),
      };
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }

  async postSaleProducts(data) {
    let connection;
    let clientData = null;
    try {
      connection = await getConnection();
      await connection.beginTransaction();

      // Validate that the client exists
      const [client] = await connection.query(
        `SELECT id FROM clients WHERE id = ?`,
        [data.client_id],
      );
      if (client.length === 0) {
        const error = new Error("Client not found");
        error.status = 404;
        throw error;
      }

      // Validate all products and stock in a single query
      const productIds = data.products.map((p) => p.product_id);
      if (productIds.length === 0) {
        const error = new Error("The sale must contain at least one product.");
        error.status = 400;
        throw error;
      }

      const placeholders = productIds.map(() => "?").join(","); // Creates ?,?,?
      const [productRows] = await connection.query(
        `SELECT id, price, stock, name FROM products WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
        productIds,
      );

      // Create a map for easy lookup
      const productMap = new Map(productRows.map((p) => [p.id, p]));

      let total = 0;
      for (const item of data.products) {
        const product = productMap.get(item.product_id);

        if (!product) {
          const error = new Error(
            `Product with ID ${item.product_id} not found or is deleted.`,
          );
          error.status = 404;
          throw error;
        }

        if (product.stock < item.quantity) {
          const error = new Error(
            `Insufficient stock for product "${product.name}" (ID: ${product.id}). Available: ${product.stock}, Requested: ${item.quantity}.`,
          );
          error.status = 400;
          throw error;
        }

        total += product.price * item.quantity;
      }

      // --- DUPLICATE CHECK (Time-based) ---
      // Check if an identical sale was created for this client in the last 10 seconds.
      const [recentSales] = await connection.query(
        `SELECT id FROM sales 
                 WHERE client_id = ? 
                   AND total = ? 
                   AND sale_type_id = 2
                   AND created_at >= NOW() - INTERVAL 10 SECOND`,
        [data.client_id, total],
      );

      if (recentSales.length > 0) {
        const error = new Error(
          "Duplicate sale detected. This sale appears to have already been created.",
        );
        error.status = 429; // 429 Too Many Requests is a good status for this.
        // We don't rollback here because we haven't changed anything yet.
        // We just throw the error.
        throw error;
      }
      // --- END DUPLICATE CHECK ---

      // Insert sale into sales table
      const [saleResult] = await connection.query(
        `INSERT INTO sales (client_id, vehicle_id, sale_type_id, payment_status_id, payment_method_id, total, observations, created_by, created_at)
                 VALUES (?, ?, 2, ?, ?, ?, ?, ?, NOW())`,
        [
          data.client_id,
          null, // A product sale never has a vehicle_id
          data.payment_status_id || 1, // Defaults to 1 ('Pendiente') if not provided
          data.payment_method_id,
          total,
          data.observations || null,
          data.created_by,
        ],
      );
      const saleId = saleResult.insertId;

      // Insert sold products and update stock in a loop
      for (const item of data.products) {
        const product = productMap.get(item.product_id);

        // Insert into sale_products
        await connection.query(
          `INSERT INTO sale_products (sale_id, product_id, quantity, price, created_by, created_at) VALUES (?, ?, ?, ?, ?, NOW())`,
          [
            saleId,
            item.product_id,
            item.quantity,
            product.price,
            data.created_by,
          ],
        );

        // Reduce stock from products table
        await connection.query(
          `UPDATE products SET stock = stock - ? WHERE id = ?`,
          [item.quantity, item.product_id],
        );

        // Get the new state of the product for a detailed audit log
        const [updatedProductRows] = await connection.query(
          `SELECT * FROM products WHERE id = ?`,
          [item.product_id],
        );

        // Audit the stock change for each product
        await auditLogService.log({
          userId: data.created_by,
          username: data.usernameToken,
          actionType: "UPDATE",
          entityType: "product",
          entityId: item.product_id,
          changes: { oldValue: product, newValue: updatedProductRows[0] },
          ipAddress: data.ipAddress,
        });
      }

      await connection.commit();

      const [clientData] = await connection.query(
        `SELECT CONCAT(first_name, ' ', last_name) AS full_name FROM clients WHERE id = ?`,
        [data.client_id],
      );

      // Get the full new state of the sale for auditing
      const [newSaleDataResult] = await connection.query(
        `SELECT * FROM sales WHERE id = ?`,
        [saleId],
      );

      const [saleProductsDetails] = await connection.query(
        `SELECT sp.product_id, p.name AS product_name, sp.quantity, sp.price, sp.subtotal 
                FROM sale_products sp 
                JOIN products p ON sp.product_id = p.id 
                WHERE sp.sale_id = ?`,
        [saleId],
      );

      // Combine sale data with product details for a complete audit record
      const newSaleState = {
        ...newSaleDataResult[0],
        client_name: clientData[0]?.full_name || "Unknown client",
        products: saleProductsDetails,
      };

      // Audit Log
      await auditLogService.log({
        userId: data.created_by,
        username: data.usernameToken,
        actionType: "CREATE",
        entityType: "sale_product",
        entityId: saleId,
        changes: { newValue: newSaleState },
        ipAddress: data.ipAddress,
      });

      return {
        message: "Sale of products created successfully",
        data: { sale_id: saleId, ...data, total },
      };
    } catch (err) {
      if (connection) await connection.rollback();
      // Audit Log for failure
      await auditLogService.log({
        userId: data.created_by,
        username: data.usernameToken,
        actionType: "CREATE",
        entityType: "sale_product",
        ipAddress: data.ipAddress,
        status: "FAILURE",
        errorMessage: err.message,
      });
      throw err;
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }

  async getSalesServices(params = {}) {
    let connection;
    try {
      connection = await getConnection();
      const {
        clientName,
        startDate,
        endDate,
        paymentStatusId,
        serviceStatusId,
      } = params;

      let query = `
            SELECT 
                s.id AS sale_id,
                CONCAT(c.first_name, ' ', c.last_name) AS client_name,
                sv.id AS service_id,
                v.brand AS vehicle_brand,
                v.model AS vehicle_model,
                v.license_plate AS vehicle_license_plate,
                sv.name AS service_name,
                ss.price,
                s.total AS sale_total,
                pm.name AS payment_method,
                ps.name AS payment_status,
                ss_status.name AS service_status,
                s.created_at,
                s.observations,
                s.started_at,
                s.completed_at,
                s.cancelled_at
            FROM sales s
            JOIN clients c ON s.client_id = c.id
            JOIN sale_services ss ON ss.sale_id = s.id
            JOIN services sv ON sv.id = ss.service_id
            JOIN vehicles v ON s.vehicle_id = v.id
            JOIN payment_methods pm ON s.payment_method_id = pm.id
            JOIN payment_status ps ON s.payment_status_id = ps.id
            JOIN service_status ss_status ON s.service_status_id = ss_status.id
            WHERE s.sale_type_id = 1
              AND s.deleted_at IS NULL`;

      const queryParams = [];

      if (clientName) {
        query += ` AND CONCAT(c.first_name, ' ', c.last_name) LIKE ?`;
        queryParams.push(`%${clientName}%`);
      }

      if (startDate) {
        query += ` AND s.created_at >= ?`;
        queryParams.push(startDate);
      }

      if (endDate) {
        query += ` AND s.created_at <= ?`;
        queryParams.push(`${endDate} 23:59:59`);
      }

      if (paymentStatusId) {
        query += ` AND s.payment_status_id = ?`;
        queryParams.push(paymentStatusId);
      }

      if (serviceStatusId) {
        query += ` AND s.service_status_id = ?`;
        queryParams.push(serviceStatusId);
      }

      query += ` ORDER BY s.created_at DESC, s.id DESC`;

      const [salesServices] = await connection.query(query, queryParams);

      const salesMap = new Map();

      salesServices.forEach((row) => {
        if (!salesMap.has(row.sale_id)) {
          salesMap.set(row.sale_id, {
            sale_id: row.sale_id,
            client_name: row.client_name,
            sale_total: row.sale_total,
            payment_method: row.payment_method,
            payment_status: row.payment_status,
            service_status: row.service_status,
            observations: row.observations,
            vehicle: {
              brand: row.vehicle_brand,
              model: row.vehicle_model,
              license_plate: row.vehicle_license_plate,
            },
            created_at: row.created_at,
            started_at: row.started_at,
            completed_at: row.completed_at,
            cancelled_at: row.cancelled_at,
            services: [],
          });
        }

        salesMap.get(row.sale_id).services.push({
          service_id: row.service_id,
          service_name: row.service_name,
          price: row.price,
        });
      });

      return {
        message: "Sales services retrieved successfully",
        data: Array.from(salesMap.values()),
      };
    } finally {
      if (connection) connection.release();
    }
  }

  async postSalesServices(data) {
    let connection;
    try {
      connection = await getConnection();
      await connection.beginTransaction();

      const {
        client_id,
        vehicle_id,
        payment_method_id,
        payment_status_id,
        observations,
        services,
        created_by,
      } = data;

      // Validate that the client exists
      const [client] = await connection.query(
        `SELECT id FROM clients WHERE id = ?`,
        [data.client_id],
      );
      if (client.length === 0) {
        const error = new Error("Client not found");
        error.status = 404;
        throw error;
      }

      // Validate vehicle_id exists for the client
      const [vehicles] = await connection.query(
        `SELECT id FROM vehicles WHERE id = ? AND client_id = ? AND deleted_at IS NULL`,
        [vehicle_id, client_id],
      );

      if (vehicles.length === 0) {
        const error = new Error(
          "Selected vehicle is not valid for this client.",
        );
        error.status = 400;
        throw error;
      }

      // Validate all services exist and get their real prices from DB
      const serviceIds = services.map((s) => s.service_id);
      if (serviceIds.length === 0) {
        const error = new Error("The sale must contain at least one service.");
        error.status = 400;
        throw error;
      }

      const placeholders = serviceIds.map(() => "?").join(",");
      const [serviceRows] = await connection.query(
        `SELECT id, price FROM services WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
        serviceIds,
      );

      // Check if any service was not found
      if (serviceRows.length !== serviceIds.length) {
        const error = new Error(
          "One or more services were not found or are deleted.",
        );
        error.status = 404;
        throw error;
      }

      // Create a map of real prices and calculate the total
      const servicePriceMap = new Map(
        serviceRows.map((s) => [s.id, parseFloat(s.price)]),
      );
      let total = 0;
      for (const { service_id } of services) {
        total += servicePriceMap.get(service_id);
      }

      // --- DUPLICATE CHECK (Time-based) ---
      // Check if an identical service sale was created for this client/vehicle in the last 10 seconds.
      const [recentSales] = await connection.query(
        `SELECT id FROM sales 
                 WHERE client_id = ? 
                   AND vehicle_id = ?
                   AND total = ? 
                   AND sale_type_id = 1
                   AND created_at >= NOW() - INTERVAL 10 SECOND`,
        [client_id, vehicle_id, total],
      );

      if (recentSales.length > 0) {
        const error = new Error(
          "Duplicate sale detected. This sale appears to have already been created.",
        );
        error.status = 429; // 429 Too Many Requests
        throw error;
      }
      // --- END DUPLICATE CHECK ---

      // Insert the main sale record with the correct total
      const [saleResult] = await connection.query(
        `INSERT INTO sales (
                client_id, vehicle_id, sale_type_id, 
                service_status_id, payment_status_id,
                payment_method_id, total, observations, created_at, created_by) 
                VALUES (?, ?, 1, 1, ?, ?, ?, ?, NOW(), ?)`,
        [
          client_id,
          vehicle_id,
          payment_status_id || 1, // Default to 'Pendiente'
          payment_method_id,
          total,
          observations || null,
          created_by || null,
        ],
      );

      const saleId = saleResult.insertId;

      // Insert each service into the sale_services table using the real price
      for (const { service_id } of services) {
        const realPrice = servicePriceMap.get(service_id);
        await connection.query(
          `INSERT INTO sale_services (sale_id, service_id, price, created_at, created_by)
                 VALUES (?, ?, ?, NOW(), ?)`,
          [saleId, service_id, realPrice, created_by || null],
        );
      }

      await connection.commit();

      // Get the full new state of the sale for auditing
      const [newSaleDataResult] = await connection.query(
        `SELECT * FROM sales WHERE id = ?`,
        [saleId],
      );

      // Also get the service details for the audit log
      const [saleServicesDetails] = await connection.query(
        `SELECT ss.service_id, s.name AS service_name, ss.price 
                FROM sale_services ss
                JOIN services s ON ss.service_id = s.id
                WHERE ss.sale_id = ?`,
        [saleId],
      );

      const [enrichedData] = await connection.query(
        `SELECT 
            CONCAT(c.first_name, ' ', c.last_name) AS client_name,
            CONCAT(v.brand, ' ', v.model, ' (', v.license_plate, ')') AS vehicle_info
         FROM clients c
         JOIN vehicles v ON v.client_id = c.id
         WHERE c.id = ? AND v.id = ?`,
        [client_id, vehicle_id],
      );

      const info = enrichedData[0];

      const newSaleState = {
        ...newSaleDataResult[0],
        client_name: info?.client_name || "Unknown client",
        vehicle_details: info?.vehicle_info || "Unknown vehicle",
        services: saleServicesDetails,
      };

      // Audit Log
      await auditLogService.log({
        userId: data.created_by,
        username: data.usernameToken,
        actionType: "CREATE",
        entityType: "sale_service",
        entityId: saleId,
        changes: { newValue: newSaleState },
        ipAddress: data.ipAddress,
      });

      return {
        message: "Sale with services created successfully",
        data: { sale_id: saleId, total, ...data },
      };
    } catch (error) {
      if (connection) await connection.rollback();
      // Audit Log for failure
      await auditLogService.log({
        userId: data.created_by,
        username: data.usernameToken,
        actionType: "CREATE",
        entityType: "sale_service",
        ipAddress: data.ipAddress,
        status: "FAILURE",
        errorMessage: error.message,
      });
      throw error;
    } finally {
      if (connection) connection.release();
    }
  }

  async getPaymentMethods() {
    let connection;
    try {
      connection = await getConnection();
      const [methods] = await connection.query(
        `SELECT id, name FROM payment_methods`,
      );
      return {
        message: "Payment methods retrieved successfully",
        data: methods,
      };
    } catch (error) {
      throw error;
    } finally {
      if (connection) connection.release();
    }
  }

  async updatePaymentStatus(
    saleId,
    { payment_status_id, updated_by, usernameToken, ipAddress },
  ) {
    let connection;
    let oldSaleData = null;
    try {
      connection = await getConnection();
      await connection.beginTransaction();

      const [sales] = await connection.query(
        `SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL`,
        [saleId],
      );

      if (sales.length === 0) {
        const error = new Error("Sale not found");
        error.status = 404;
        throw error;
      }
      oldSaleData = sales[0];

      if (sales[0].payment_status_id === payment_status_id) {
        const error = new Error(
          "Sale is already in the requested payment status.",
        );
        error.status = 400; // Bad Request, as no change is needed
        throw error;
      }

      // If the payment status is 'Canceled' (ID 3), also update the service status to 'Canceled'.
      if (payment_status_id === 3) {
        // Find the ID for the 'Cancelado' service status
        const [serviceStatusRows] = await connection.query(
          `SELECT id FROM service_status WHERE name = 'Cancelado' LIMIT 1`,
        );

        if (serviceStatusRows.length === 0) {
          // This is a server-side issue, the status should exist
          throw new Error(
            "Internal Server Error: 'Cancelado' service status not found.",
          );
        }
        const canceledServiceStatusId = serviceStatusRows[0].id;

        // Update both payment and service status
        await connection.query(
          `UPDATE sales SET payment_status_id = ?, service_status_id = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
          [payment_status_id, canceledServiceStatusId, updated_by, saleId],
        );
      } else {
        // Update only the payment status for other cases
        await connection.query(
          `UPDATE sales SET payment_status_id = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
          [payment_status_id, updated_by, saleId],
        );
      }

      // If a product sale is canceled (ID 3), restore stock
      if (oldSaleData.sale_type_id === 2 && payment_status_id === 3) {
        // 1. Get all products from the sale
        const [saleProducts] = await connection.query(
          `SELECT product_id, quantity FROM sale_products WHERE sale_id = ?`,
          [saleId],
        );

        // 2. Loop through them and restore stock
        for (const item of saleProducts) {
          const [oldProductRows] = await connection.query(
            `SELECT * FROM products WHERE id = ?`,
            [item.product_id],
          );

          await connection.query(
            `UPDATE products SET stock = stock + ? WHERE id = ?`,
            [item.quantity, item.product_id],
          );

          const [newProductRows] = await connection.query(
            `SELECT * FROM products WHERE id = ?`,
            [item.product_id],
          );

          // Audit the stock restoration for each product
          await auditLogService.log({
            userId: updated_by,
            username: usernameToken,
            actionType: "UPDATE",
            entityType: "product",
            entityId: item.product_id,
            changes: {
              oldValue: oldProductRows[0],
              newValue: newProductRows[0],
              reason: `Stock restored from canceled sale #${saleId}`,
            },
            ipAddress: ipAddress,
          });
        }
      }

      await connection.commit();

      // Get the full new state of the sale for auditing
      const [newSaleDataResult] = await connection.query(
        `SELECT * FROM sales WHERE id = ?`,
        [saleId],
      );
      const newSaleData = newSaleDataResult[0];

      // Determine the correct entity type based on the sale type
      const entityType =
        oldSaleData.sale_type_id === 1 ? "sale_service" : "sale_product";

      // Audit Log for success
      await auditLogService.log({
        userId: updated_by,
        username: usernameToken,
        actionType: "UPDATE",
        entityType: entityType,
        entityId: saleId,
        changes: { oldValue: oldSaleData, newValue: newSaleData },
        ipAddress: ipAddress,
      });

      return {
        message: "Sale payment status updated successfully",
        data: { sale_id: saleId, payment_status_id },
      };
    } catch (error) {
      if (connection) await connection.rollback();
      // Determine entity type even on failure, if possible
      const entityType = oldSaleData
        ? oldSaleData.sale_type_id === 1
          ? "sale_service"
          : "sale_product"
        : "sale";

      // Audit Log for failure
      await auditLogService.log({
        userId: updated_by,
        username: usernameToken,
        actionType: "UPDATE",
        entityType: entityType,
        entityId: saleId,
        ipAddress: ipAddress,
        status: "FAILURE",
        errorMessage: error.message,
      });
      throw error;
    } finally {
      if (connection) connection.release();
    }
  }

  async updateServiceStatus(
    saleId,
    { service_status_id, updated_by, usernameToken, ipAddress },
  ) {
    let connection;
    let oldSaleData = null;
    try {
      connection = await getConnection();
      await connection.beginTransaction();

      const [sales] = await connection.query(
        `SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL`,
        [saleId],
      );

      if (sales.length === 0) throw new Error("Service sale not found");
      oldSaleData = sales[0];

      let timeUpdateQuery = "";
      let extraFieldsQuery = "";

      if (service_status_id === 2 && !oldSaleData.started_at) {
        timeUpdateQuery = ", started_at = NOW()";
      } else if (service_status_id === 3 && !oldSaleData.completed_at) {
        const startPart = !oldSaleData.started_at ? ", started_at = NOW()" : "";
        timeUpdateQuery = `${startPart}, completed_at = NOW()`;
      } else if (service_status_id === 4) {
        timeUpdateQuery = ", cancelled_at = NOW()";

        extraFieldsQuery = ", payment_status_id = 3";
      }

      await connection.query(
        `UPDATE sales SET service_status_id = ?, updated_by = ?, updated_at = NOW() 
       ${timeUpdateQuery} ${extraFieldsQuery} WHERE id = ?`,
        [service_status_id, updated_by, saleId],
      );

      await connection.commit();

      const [newSaleDataResult] = await connection.query(
        `SELECT * FROM sales WHERE id = ?`,
        [saleId],
      );

      await auditLogService.log({
        userId: updated_by,
        username: usernameToken,
        actionType: "UPDATE",
        entityType: "sale_service",
        entityId: saleId,
        changes: { oldValue: oldSaleData, newValue: newSaleDataResult[0] },
        ipAddress: ipAddress,
      });

      return {
        message: "Sale service status updated successfully",
        data: { sale_id: saleId, service_status_id },
      };
    } catch (error) {
      if (connection) await connection.rollback();
      await auditLogService.log({
        userId: updated_by,
        username: usernameToken,
        actionType: "UPDATE",
        entityType: "sale_service",
        entityId: saleId,
        ipAddress: ipAddress,
        status: "FAILURE",
        errorMessage: error.message,
      });
      throw error;
    } finally {
      if (connection) connection.release();
    }
  }
}

module.exports = SalesService;
