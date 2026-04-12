const path = require("path");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");

const Product = require("./src/models/Product");
const Customer = require("./src/models/Customer");
const Order = require("./src/models/Order");

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb+srv://apslun:abdoolfree1@cluster0.vo1kj74.mongodb.net/ai";

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "simple-store-secret",
    resave: false,
    saveUninitialized: false,
  })
);

function requireAuth(req, res, next) {
  if (!req.session.user) {
    // For API requests, return JSON instead of redirecting
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    return res.redirect("/login");
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.isAdmin) {
    return res.status(403).send("You are not authorized to access admin pages.");
  }
  next();
}

app.get("/", requireAuth, async (req, res) => {
  const products = await Product.find().sort({ createdAt: -1 }).lean();
  const userOrders = await Order.find({ customerName: req.session.user.name })
    .sort({ createdAt: -1 })
    .lean();

  // Get unique categories from products
  const categories = [...new Set(products.map(p => p.category || "General"))];

  res.render("home", {
    products,
    categories,
    userOrders,
    user: req.session.user,
    error: null,
    success: req.session.success || null,
  });

  req.session.success = null;
});

app.get("/invoices/:invoiceNumber", requireAuth, async (req, res) => {
  const order = await Order.findOne({
    invoiceNumber: req.params.invoiceNumber,
  }).lean();

  if (!order) {
    return res.status(404).send("Invoice not found.");
  }

  const canView =
    req.session.user.isAdmin || order.customerName === req.session.user.name;
  if (!canView) {
    return res.status(403).send("You are not authorized to view this invoice.");
  }

  res.render("invoice", {
    order,
    user: req.session.user,
  });
});

app.get("/invoices-orders", requireAuth, async (req, res) => {
  const q = (req.query.q || "").trim();
  const status = ["all", "pending", "process", "completed"].includes(req.query.status)
    ? req.query.status
    : "all";
  
  // Set default date range to current month
  const now = new Date();
  const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  
  let from = (req.query.from || "").trim();
  let to = (req.query.to || "").trim();
  
  // Default to current month if no dates provided
  if (!from) {
    from = firstDayOfMonth.toISOString().split('T')[0];
  }
  if (!to) {
    to = lastDayOfMonth.toISOString().split('T')[0];
  }

  const match = {};
  if (!req.session.user.isAdmin) {
    match.customerName = req.session.user.name;
  }
  if (status !== "all") {
    match.status = status;
  }

  if (from || to) {
    match.createdAt = {};
    if (from) {
      const fromDate = new Date(`${from}T00:00:00.000Z`);
      if (!Number.isNaN(fromDate.getTime())) {
        match.createdAt.$gte = fromDate;
      }
    }
    if (to) {
      const toDate = new Date(`${to}T23:59:59.999Z`);
      if (!Number.isNaN(toDate.getTime())) {
        match.createdAt.$lte = toDate;
      }
    }
    if (!match.createdAt.$gte && !match.createdAt.$lte) {
      delete match.createdAt;
    }
  }

  let orders = await Order.find(match).sort({ createdAt: -1 }).lean();

  if (q) {
    const qLower = q.toLowerCase();
    orders = orders.filter((order) => {
      const inItems = order.items.some((item) =>
        item.name.toLowerCase().includes(qLower)
      );
      return (
        order.invoiceNumber.toLowerCase().includes(qLower) ||
        order.customerName.toLowerCase().includes(qLower) ||
        order.status.toLowerCase().includes(qLower) ||
        inItems
      );
    });
  }

  const summary = orders.reduce(
    (acc, order) => {
      acc.ordersCount += 1;
      acc.itemsCount += order.items.reduce((sum, item) => sum + item.quantity, 0);
      acc.totalAmount += order.total;
      if (order.status === "pending") acc.pendingCount += 1;
      if (order.status === "completed") acc.completedCount += 1;
      return acc;
    },
    {
      ordersCount: 0,
      itemsCount: 0,
      totalAmount: 0,
      pendingCount: 0,
      completedCount: 0,
    }
  );

  // Calculate products sales summary
  const productSales = new Map();
  const purchasedProductsWithDate = [];
  orders.forEach((order) => {
    // Get the order date - it should be a Date object from Mongoose
    const orderDate = order.createdAt || new Date();
    // Format the date as MM/DD/YYYY for display
    const formattedDate = new Date(orderDate).toLocaleDateString('en-US');
    
    order.items.forEach((item) => {
      purchasedProductsWithDate.push({
        ...item,
        purchaseDate: formattedDate,  // Pass as formatted string
      });
      if (!productSales.has(item.productId.toString())) {
        productSales.set(item.productId.toString(), {
          productId: item.productId,
          name: item.name,
          totalQuantity: 0,
          totalAmount: 0,
        });
      }
      const sale = productSales.get(item.productId.toString());
      sale.totalQuantity += item.quantity;
      sale.totalAmount += item.subtotal;
    });
  });

  const products = Array.from(productSales.values()).sort((a, b) => b.totalAmount - a.totalAmount);

  res.render("invoices-orders", {
    user: req.session.user,
    orders,
    products,
    purchasedProducts: purchasedProductsWithDate,
    summary,
    filters: {
      q,
      status,
      from,
      to,
    },
  });
});

app.get("/login", (req, res) => {
  if (req.session.user) {
    return res.redirect("/");
  }
  res.render("login", { error: null });
});

app.post("/login", async (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) {
    return res.status(400).render("login", {
      error: "Please enter your name.",
    });
  }

  const customer = await Customer.findOne({ name });
  if (!customer) {
    return res.status(400).render("login", {
      error: "Name not found. Ask admin to add your account.",
    });
  }

  req.session.user = {
    name: customer.name,
    isAdmin: customer.isAdmin,
  };

  res.redirect("/");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.post("/orders", requireAuth, async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (items.length === 0) {
    req.session.success = "Choose products before placing an order.";
    return res.redirect("/");
  }

  // Separate manual products from regular products
  const manualItems = items.filter((item) => String(item.productId).startsWith("manual-"));
  const regularItems = items.filter((item) => !String(item.productId).startsWith("manual-"));
  
  // Get regular products from database
  let productMap = new Map();
  if (regularItems.length > 0) {
    const productIds = regularItems.map((item) => item.productId);
    const products = await Product.find({ _id: { $in: productIds } }).lean();
    productMap = new Map(products.map((p) => [String(p._id), p]));
  }

  const orderItems = [];
  let total = 0;

  // Process regular products
  for (const item of regularItems) {
    const product = productMap.get(item.productId);
    const qty = Number(item.quantity) || 0;
    if (!product || qty <= 0) {
      continue;
    }
    orderItems.push({
      productId: product._id,
      name: product.name,
      unitPrice: product.price,
      quantity: qty,
      subtotal: product.price * qty,
      itemStatus: "pending",
    });
    total += product.price * qty;
  }

  // Process manual products
  for (const item of manualItems) {
    const qty = Number(item.quantity) || 0;
    const price = Number(item.price) || 0;
    const name = (item.name || "").trim();
    
    if(!name || qty <= 0 || price <= 0) {
      continue;
    }
    
    orderItems.push({
      productId: null,  // Manual products don't have a database ID
      name: name,
      unitPrice: price,
      quantity: qty,
      subtotal: price * qty,
      itemStatus: "pending",
    });
    total += price * qty;
  }

  if (orderItems.length === 0) {
    req.session.success = "Order could not be created due to invalid items.";
    return res.redirect("/");
  }

  const invoiceNumber = `INV-${Date.now()}`;
  await Order.create({
    customerName: req.session.user.name,
    items: orderItems,
    total,
    status: "pending",
    invoiceNumber,
  });

  req.session.success = `Order placed successfully. Invoice: ${invoiceNumber}`;
  res.redirect("/");
});

// Get user's orders
app.get("/api/my-orders", requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    if (!user || !user.name) {
      return res.status(401).json({ error: "User not authenticated" });
    }
    const orders = await Order.find({ customerName: user.name }).sort({ createdAt: -1 }).lean();
    res.json(orders || []);
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({ error: "Failed to load orders", message: error.message });
  }
});

app.get("/admin", requireAuth, requireAdmin, async (req, res) => {
  const tab = ["forms", "products", "invoices", "pending", "process"].includes(req.query.tab)
    ? req.query.tab
    : "forms";

  const [customers, products, orders] = await Promise.all([
    Customer.find().sort({ createdAt: -1 }).lean(),
    Product.find().sort({ createdAt: -1 }).lean(),
    Order.find().sort({ createdAt: -1 }).lean(),
  ]);

  const purchasedRows = [];
  for (const order of orders) {
    for (const item of order.items) {
      purchasedRows.push({
        customerName: order.customerName,
        productName: item.name,
        quantity: item.quantity,
        subtotal: item.subtotal,
        invoiceNumber: order.invoiceNumber,
        status: order.status,
        createdAt: order.createdAt,
      });
    }
  }

  const pendingOrders = orders.filter((o) => o.status === "pending" || o.status === "process");

  res.render("admin", {
    user: req.session.user,
    tab,
    customers,
    products,
    purchasedRows,
    pendingOrders,
    error: null,
    req,
  });
});

app.post("/admin/products", requireAuth, requireAdmin, async (req, res) => {
  const name = (req.body.name || "").trim();
  const image = (req.body.image || "").trim();
  const category = (req.body.category || "General").trim();
  const price = Number(req.body.price);
  const quantity = Number(req.body.quantity) || 0;
  const isEditable = req.body.isEditable === "on" || req.body.isEditable === true;

  if (!name || !price || price <= 0) {
    return res.status(400).send("Invalid product data.");
  }

  await Product.create({
    name,
    price,
    quantity,
    image,
    category,
    isEditable,
  });

  res.redirect("/admin?tab=forms");
});

app.post(
  "/admin/products/:id/update",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const name = (req.body.name || "").trim();
    const image = (req.body.image || "").trim();
    const category = (req.body.category || "General").trim();
    const price = Number(req.body.price);
    const quantity = Number(req.body.quantity) || 0;
    const isEditable = req.body.isEditable === "on" || req.body.isEditable === true;

    if (!name || !price || price <= 0) {
      return res.status(400).send("Invalid product data.");
    }

    await Product.findByIdAndUpdate(req.params.id, {
      name,
      image,
      price,
      quantity,
      category,
      isEditable,
    });
    res.redirect("/admin?tab=products");
  }
);

app.post(
  "/admin/products/:id/delete",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    await Product.findByIdAndDelete(req.params.id);
    res.redirect("/admin?tab=products");
  }
);

app.post("/admin/customers", requireAuth, requireAdmin, async (req, res) => {
  const name = (req.body.name || "").trim();
  const isAdmin = req.body.isAdmin === "on";

  if (!name) {
    return res.status(400).send("Please enter a name.");
  }

  const existing = await Customer.findOne({ name });
  if (!existing) {
    await Customer.create({ name, isAdmin });
  }

  res.redirect("/admin?tab=forms");
});

app.post(
  "/admin/orders/:id/complete",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    await Order.findByIdAndUpdate(req.params.id, { status: "completed" });
    
    // Check if request expects JSON
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({ success: true });
    }
    
    res.redirect("/admin?tab=pending");
  }
);

// Edit item quantity in order
app.post(
  "/admin/orders/:orderId/items/:itemIndex/quantity",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const newQuantity = Number(req.body.quantity);
    if (isNaN(newQuantity) || newQuantity <= 0) {
      return res.status(400).json({ error: "Invalid quantity" });
    }

    const order = await Order.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const itemIndex = Number(req.params.itemIndex);
    if (itemIndex < 0 || itemIndex >= order.items.length) {
      return res.status(400).json({ error: "Invalid item index" });
    }

    const item = order.items[itemIndex];
    item.quantity = newQuantity;
    item.subtotal = item.unitPrice * newQuantity;

    let newTotal = 0;
    for (const it of order.items) {
      newTotal += it.subtotal;
    }
    order.total = newTotal;

    await order.save();
    res.json({ success: true, newQuantity, newSubtotal: item.subtotal, newTotal });
  }
);

// Edit item quantity in order (user can edit their own orders)
app.post(
  "/api/orders/:orderId/items/:itemIndex/quantity",
  requireAuth,
  async (req, res) => {
    const newQuantity = Number(req.body.quantity);
    if (isNaN(newQuantity) || newQuantity <= 0) {
      return res.status(400).json({ error: "Invalid quantity" });
    }

    const order = await Order.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Check if user owns this order or is admin
    const user = req.session.user;
    const customer = await Customer.findById(user.id);
    if (order.customerName !== user.name && !customer.isAdmin) {
      return res.status(403).json({ error: "You don't have permission to edit this order" });
    }

    const itemIndex = Number(req.params.itemIndex);
    if (itemIndex < 0 || itemIndex >= order.items.length) {
      return res.status(400).json({ error: "Invalid item index" });
    }

    const item = order.items[itemIndex];
    item.quantity = newQuantity;
    item.subtotal = item.unitPrice * newQuantity;

    let newTotal = 0;
    for (const it of order.items) {
      newTotal += it.subtotal;
    }
    order.total = newTotal;

    await order.save();
    res.json({ success: true, newQuantity, newSubtotal: item.subtotal, newTotal });
  }
);

// Edit item price in order (user can edit their own orders)
app.post(
  "/api/orders/:orderId/items/:itemIndex/price",
  requireAuth,
  async (req, res) => {
    const newPrice = Number(req.body.price);
    if (isNaN(newPrice) || newPrice <= 0) {
      return res.status(400).json({ error: "Invalid price" });
    }

    const order = await Order.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Check if user owns this order or is admin
    const user = req.session.user;
    const customer = await Customer.findById(user.id);
    if (order.customerName !== user.name && !customer.isAdmin) {
      return res.status(403).json({ error: "You don't have permission to edit this order" });
    }

    const itemIndex = Number(req.params.itemIndex);
    if (itemIndex < 0 || itemIndex >= order.items.length) {
      return res.status(400).json({ error: "Invalid item index" });
    }

    const item = order.items[itemIndex];
    item.unitPrice = newPrice;
    item.subtotal = item.unitPrice * item.quantity;

    let newTotal = 0;
    for (const it of order.items) {
      newTotal += it.subtotal;
    }
    order.total = newTotal;

    await order.save();
    res.json({ success: true, newPrice, newSubtotal: item.subtotal, newTotal });
  }
);

// Delete item from order
app.post(
  "/admin/orders/:orderId/items/:itemIndex/delete",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const order = await Order.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const itemIndex = Number(req.params.itemIndex);
    if (itemIndex < 0 || itemIndex >= order.items.length) {
      return res.status(400).json({ error: "Invalid item index" });
    }

    order.items.splice(itemIndex, 1);

    let newTotal = 0;
    for (const it of order.items) {
      newTotal += it.subtotal;
    }
    order.total = newTotal;

    if (order.items.length === 0) {
      await Order.findByIdAndDelete(req.params.orderId);
      return res.json({ success: true, deleted: true });
    }

    await order.save();
    res.json({ success: true });
  }
);

// Edit item price in order
app.post(
  "/admin/orders/:orderId/items/:itemIndex/price",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const newPrice = Number(req.body.unitPrice);
    if (isNaN(newPrice) || newPrice <= 0) {
      return res.status(400).json({ error: "Invalid price" });
    }

    const order = await Order.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const itemIndex = Number(req.params.itemIndex);
    if (itemIndex < 0 || itemIndex >= order.items.length) {
      return res.status(400).json({ error: "Invalid item index" });
    }

    const item = order.items[itemIndex];
    item.unitPrice = newPrice;
    item.subtotal = newPrice * item.quantity;

    let newTotal = 0;
    for (const it of order.items) {
      newTotal += it.subtotal;
    }
    order.total = newTotal;

    await order.save();
    res.json({ success: true, newPrice, newSubtotal: item.subtotal, newTotal });
  }
);

// Mark individual item as completed
app.post(
  "/admin/orders/:orderId/items/:itemIndex/complete",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const order = await Order.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const itemIndex = Number(req.params.itemIndex);
    if (itemIndex < 0 || itemIndex >= order.items.length) {
      return res.status(400).json({ error: "Invalid item index" });
    }

    order.items[itemIndex].itemStatus = "completed";

    const allCompleted = order.items.every((item) => item.itemStatus === "completed");
    const someCompleted = order.items.some((item) => item.itemStatus === "completed");

    if (allCompleted) {
      order.status = "completed";
    } else if (someCompleted) {
      order.status = "process";
    }

    await order.save();
    res.json({ success: true });
  }
);

// Mark individual item as pending
app.post(
  "/admin/orders/:orderId/items/:itemIndex/pending",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const order = await Order.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const itemIndex = Number(req.params.itemIndex);
    if (itemIndex < 0 || itemIndex >= order.items.length) {
      return res.status(400).json({ error: "Invalid item index" });
    }

    order.items[itemIndex].itemStatus = "pending";
    order.status = "pending";

    await order.save();
    res.json({ success: true });
  }
);

// Start processing order (change status from pending to process)
app.post(
  "/admin/orders/:id/start-process",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (order.status !== "pending") {
      return res.status(400).json({ error: "Order is not pending" });
    }

    order.status = "process";
    await order.save();
    res.json({ success: true });
  }
);

async function bootstrap() {
  await mongoose.connect(MONGO_URI);
  const adminExists = await Customer.findOne({ isAdmin: true });
  if (!adminExists) {
    await Customer.create({ name: "admin", isAdmin: true });
  }
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error("Failed to start server:", error.message);
  process.exit(1);
});
