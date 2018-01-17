const express = require('express')
const redis = require('redis')
const redisScan = require('redisscan')
const bodyParser = require('body-parser')
const app = express()
const client = redis.createClient()
const {promisify} = require('util')
const existsAsync = promisify(client.exists).bind(client)
const getAsync = promisify(client.get).bind(client)
const hgetallAsync = promisify(client.hgetall).bind(client)
//
// redisScan({
//     redis: client,
//     pattern: 'product:*',
//     keys_only: true,
//     each_callback: function (type, key, subkey, length, value, cb) {
//         console.log(key)
//         cb()
//     },
//     done_callback: function (err) {
//         console.log("-=-=-=-=-=--=-=-=-")
//     }
// })

// desconstruct json blob into array of hmset fields
const jsonToHmFields = (jsonBlob) => {
    let setArray = []
    const keys = Object.keys(jsonBlob)
    keys.forEach(key => {
        setArray.push(key)
        setArray.push(jsonBlob[key])
    })
    return setArray
}

// Parse Request Bodies
app.use(bodyParser.urlencoded({
    extended: true
}))
app.use(bodyParser.json())

// Routes

// Index Route
app.get('/', (req, res) => res.send('<h1 style="text-align:center">Hello Redis Product Catalog!</h1>'))

// Category Schema
//    * Id : Number
//    * Name : String
//    * Products : Product (0..n)

// Category Routes

//Create Category
app.post('/category', (req, res) => {
    const requiredFields = ['name']
    let category = req.body
    let postValid = true
    let invalid = ''
    requiredFields.forEach(field => {
        if (!(field in category)) {
            postValid = false
            invalid += 'Missing Field '+ field+ '\n'
        }
    })

    if (postValid !== true) {
        return res.status(400).send(invalid)
    } else {
        client.incr('counter:categories', (err, idx) => {
            if (err) {
                return res.status(500).send(err)
            }
            category['id'] = idx
            const hmFields = jsonToHmFields(category)
            client.hmset('category:'+category.id, hmFields)
            return res.status(200).send(category)
        })

    }
})

// Get Single Category
app.get('/category/:categoryId', (req, res) => {
    const categoryId = req.params.categoryId
    if (!categoryId || categoryId != parseInt(categoryId)) {
        return res.status(400).send('Need Valid Category Id')
    }
    client.hgetall(`category:${categoryId}`, function (err, category) {
        if (err) {
            return res.status(500).send(err)
        }
        return res.status(200).send(category)
    })
})

// Get Single Category's Products
app.get('/category/:categoryId/products', (req, res) => {
    const categoryId = req.params.categoryId
    if (!categoryId || categoryId != parseInt(categoryId)) {
        return res.status(400).send('Need Valid Category Id')
    }
    client.smembers(`category:${categoryId}:products`, function (err, products) {
        if (err) {
            return res.status(500).send(err)
        }
        productPromises = []
        products.forEach((product) => {
            productPromises.push(hgetallAsync(`${product}`))
        })
        Promise.all(productPromises).then((values) => {
            return res.status(200).send(values)
        })
    })
})

// Delete Single Category
app.delete('/category/:categoryId', (req, res) => {
    const categoryId = req.params.categoryId
    if (!categoryId || categoryId != parseInt(categoryId)) {
        return res.status(400).send('Need Valid Category Id')
    }
    client.del(`category:${categoryId}`, function (err, category) {
        if (err) {
            return res.status(500).send(err)
        }
        if (category === 0) {
            return res.status(404).send()
        }
        return res.status(200).send()
    })
})

// Product Schema
//    * Id : Number
//    * Name : String
//    * Description: String
//    * Vendor : String
//    * Price : Number
//    * Currency : String
//    * MainCategory : Category (1)
//    * Images : Image (0..n)

// Product Routes

// Create Product
app.post('/product', (req, res) => {
    const requiredFields = ['name', 'description', 'vendor', 'price', 'currency', 'mainCategory']
    let product = req.body
    let postValid = true
    let invalid = ''
    requiredFields.forEach(field => {
        if (!(field in product)) {
            postValid = false
            invalid += 'Missing Field '+ field+ '\n'
        }
    })

    if (postValid !== true) {
        return res.status(400).send(invalid)
    } else {
        // Check to see if the specified MainCategory is Valid
        existsAsync(`category:${product.mainCategory}`)
        .then((data) => {
            if (data === 1) {
                client.incr('counter:products', (err, idx) => {
                    if (err) {
                        return res.status(500).send(err)
                    }
                    product['id'] = idx
                    const hmFields = jsonToHmFields(product)
                    client.hmset(`product:${product.id}`, hmFields)
                    client.sadd(`category:${product.mainCategory}:products`, `product:${product.id}`)
                    client.sadd(`products:all`, `product:${product.id}`)
                    return res.status(200).send(product)
                })
            }
            else {
                return res.status(400).send('Category Does Not Exist! Check mainCategory Field!')
            }
        })

    }
})

// Get All Products

app.get('/products', (req, res) => {
    client.smembers(`products:all`, function (err, products) {
        if (err) {
            return res.status(500).send(err)
        }
        productPromises = []
        products.forEach((product) => {
            productPromises.push(hgetallAsync(`${product}`))
        })
        Promise.all(productPromises).then((products) => {
            if (!req.query.q) {
                return res.status(200).send(products)
            } else {
                const query = req.query.q
                matchingProducts = []
                products.forEach((product) => {
                    if (product.name.indexOf(query) > -1) {
                        matchingProducts.push(product)
                    }
                })
                return res.status(200).send(matchingProducts)
            }
        })
    })
})

// Get Single Product
app.get('/product/:productId', (req, res) => {
    const productId = req.params.productId
    if (!productId || productId != parseInt(productId)) {
        return res.status(400).send('Need Valid Product Id')
    }
    client.hgetall(`product:${productId}`, function (err, product) {
        if (err) {
            return res.status(500).send(err)
        }
        return res.status(200).send(product)
    })
})

// Delete Single Product
app.delete('/product/:productId', (req, res) => {
    const productId = req.params.productId
    if (!productId || productId != parseInt(productId)) {
        return res.status(400).send('Need Valid Product Id')
    }
    // get the mainCategoryID and update the set
    client.hget(`product:${productId}`, 'mainCategory', function (err, category) {
        if (err) {
            return res.status(500).send(err)
        }
        client.srem(`category:${category}:products`, `product:${productId}`)
    })
    client.srem(`products:all`, `product:${product.id}`)
    client.del(`product:${productId}`, function (err, product) {
        if (err) {
            return res.status(500).send(err)
        }
        if (product === 0) {
            return res.status(404).send()
        }
        return res.status(200).send()
    })
})

app.listen(3000, () => console.log('Example app listening on port 3000!'))
