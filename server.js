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

  res.render("home", {
    products,
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
  const status = ["all", "pending", "completed"].includes(req.query.status)
    ? req.query.status
    : "all";
  const from = (req.query.from || "").trim();
  const to = (req.query.to || "").trim();

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

  // Fetch products
  const products = await Product.find().sort({ createdAt: -1 }).lean();

  res.render("invoices-orders", {
    user: req.session.user,
    orders,
    products,
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

  const productIds = items.map((item) => item.productId);
  const products = await Product.find({ _id: { $in: productIds } }).lean();
  const productMap = new Map(products.map((p) => [String(p._id), p]));

  const orderItems = [];
  let total = 0;

  for (const item of items) {
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
    });
    total += product.price * qty;
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

app.get("/admin", requireAuth, requireAdmin, async (req, res) => {
  const tab = ["forms", "products", "invoices", "pending"].includes(req.query.tab)
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

  const pendingOrders = orders.filter((o) => o.status === "pending");

  res.render("admin", {
    user: req.session.user,
    tab,
    customers,
    products,
    purchasedRows,
    pendingOrders,
    error: null,
  });
});

app.post("/admin/products", requireAuth, requireAdmin, async (req, res) => {
  const name = (req.body.name || "").trim();
  const image = (req.body.image || "").trim();
  const price = Number(req.body.price);
  const quantity = Number(req.body.quantity) || 0;

  if (!name || !price || price <= 0) {
    return res.status(400).send("Invalid product data.");
  }

  await Product.create({
    name,
    price,
    quantity,
    image,
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
    const price = Number(req.body.price);
    const quantity = Number(req.body.quantity) || 0;

    if (!name || !price || price <= 0) {
      return res.status(400).send("Invalid product data.");
    }

    await Product.findByIdAndUpdate(req.params.id, {
      name,
      image,
      price,
      quantity,
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
    res.redirect("/admin?tab=pending");
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
