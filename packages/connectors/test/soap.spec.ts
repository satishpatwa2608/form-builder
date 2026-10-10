import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as soap from 'soap';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultRegistry, parseWsdl, soapEnvelope, soapRows, wsdlImports, type ConnectorRecord, type OperationRequest } from '../src';

const NS = 'urn:acme:customers';
const SCHEMA = (qualified = true) => `
    <xsd:schema targetNamespace="${NS}" ${qualified ? 'elementFormDefault="qualified"' : ''} xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="${NS}">
      <xsd:complexType name="Customer"><xsd:sequence>
        <xsd:element name="no" type="xsd:string"/><xsd:element name="name" type="xsd:string"/><xsd:element name="city" type="xsd:string" minOccurs="0"/><xsd:element name="credit" type="xsd:decimal" minOccurs="0"/>
      </xsd:sequence></xsd:complexType>
      <xsd:complexType name="Order"><xsd:sequence><xsd:element name="item" type="xsd:string"/><xsd:element name="qty" type="xsd:int"/></xsd:sequence></xsd:complexType>
      <xsd:element name="GetCustomer"><xsd:complexType><xsd:sequence><xsd:element name="no" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element>
      <xsd:element name="GetCustomerResponse"><xsd:complexType><xsd:sequence><xsd:element name="customer" type="tns:Customer" minOccurs="0"/></xsd:sequence></xsd:complexType></xsd:element>
      <xsd:element name="ListOrders"><xsd:complexType><xsd:sequence><xsd:element name="customerNo" type="xsd:string"/><xsd:element name="status" type="xsd:string" minOccurs="0"/></xsd:sequence></xsd:complexType></xsd:element>
      <xsd:element name="ListOrdersResponse"><xsd:complexType><xsd:sequence><xsd:element name="orders"><xsd:complexType><xsd:sequence><xsd:element name="order" type="tns:Order" minOccurs="0" maxOccurs="unbounded"/></xsd:sequence></xsd:complexType></xsd:element></xsd:sequence></xsd:complexType></xsd:element>
      <xsd:element name="AddComplaint"><xsd:complexType><xsd:sequence><xsd:element name="customerNo" type="xsd:string"/><xsd:element name="text" type="xsd:string"/><xsd:element name="urgent" type="xsd:boolean" minOccurs="0"/></xsd:sequence></xsd:complexType></xsd:element>
      <xsd:element name="AddComplaintResponse"><xsd:complexType><xsd:sequence><xsd:element name="id" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element>
    </xsd:schema>`;
const WSDL = (address: string, types = `<types>${SCHEMA()}</types>`) => `<?xml version="1.0"?>
<definitions name="Customers" targetNamespace="${NS}" xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:tns="${NS}" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  ${types}
  ${['GetCustomer', 'ListOrders', 'AddComplaint'].map((o) => `<message name="${o}In"><part name="parameters" element="tns:${o}"/></message><message name="${o}Out"><part name="parameters" element="tns:${o}Response"/></message>`).join('')}
  <portType name="CustomerPort">${['GetCustomer', 'ListOrders', 'AddComplaint'].map((o) => `<operation name="${o}"><input message="tns:${o}In"/><output message="tns:${o}Out"/></operation>`).join('')}</portType>
  <binding name="CustomerBinding" type="tns:CustomerPort"><soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    ${['GetCustomer', 'ListOrders', 'AddComplaint'].map((o) => `<operation name="${o}"><soap:operation soapAction="${NS}/${o}"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>`).join('')}
  </binding>
  <service name="CustomerService"><port name="CustomerPort" binding="tns:CustomerBinding"><soap:address location="${address}"/></port></service>
</definitions>`;

describe('reading a WSDL', () => {
  it('finds each operation: where it is called, what it takes in order, and what its rows hold', () => {
    const [get, orders, add] = parseWsdl(WSDL('https://erp.acme.test/soap'));
    expect(get).toEqual({
      name: 'GetCustomer',
      endpoint: 'https://erp.acme.test/soap',
      action: `${NS}/GetCustomer`,
      version: '1.1',
      request: { element: 'GetCustomer', namespace: NS, qualified: true, fields: [{ name: 'no', type: 'string', nullable: false }] },
      // Down through the wrapper to the customer itself.
      returns: [{ name: 'no', type: 'string', nullable: false }, { name: 'name', type: 'string', nullable: false }, { name: 'city', type: 'string', nullable: true }, { name: 'credit', type: 'number', nullable: true }],
    });
    expect(orders!.returns.map((f) => [f.name, f.type])).toEqual([['item', 'string'], ['qty', 'number']]);
    expect(add!.request.fields.map((f) => [f.name, f.type, f.nullable])).toEqual([['customerNo', 'string', false], ['text', 'string', false], ['urgent', 'boolean', true]]);
  });

  it('reads schemas kept in files of their own, and finds their addresses relative to the description', () => {
    const wsdl = WSDL('https://erp.acme.test/soap', `<types><xsd:schema><xsd:import namespace="${NS}" schemaLocation="schemas/customers.xsd?v=1&amp;x=2"/></xsd:schema></types>`);
    expect(wsdlImports(wsdl, 'https://erp.acme.test/services/customers?wsdl')).toEqual(['https://erp.acme.test/services/schemas/customers.xsd?v=1&x=2']);
    expect(() => parseWsdl(wsdl)).toThrow('No operations could be read');
    expect(parseWsdl(wsdl, [`<?xml version="1.0"?>${SCHEMA()}`]).map((o) => o.name)).toEqual(['GetCustomer', 'ListOrders', 'AddComplaint']);
  });

  it('says so when a service speaks the old rpc/encoded style, or the address gave something else', () => {
    const old = WSDL('https://erp.acme.test/soap').replace('style="document"', 'style="rpc"').replace(/use="literal"/g, 'use="encoded"');
    expect(() => parseWsdl(old)).toThrow('old "rpc/encoded" style');
    expect(() => parseWsdl('<html><body>Sign in</body></html>')).toThrow('did not give a WSDL');
  });
});

describe('a SOAP message', () => {
  const [, orders] = parseWsdl(WSDL('https://erp.acme.test/soap'));
  it('carries the inputs in the order the description gives them, with nothing typed able to break out of its element', () => {
    const xml = soapEnvelope(orders!, { status: 'open & <shut>', customerNo: 'C1</m:customerNo><m:customerNo>C2', notInTheDescription: 'x' });
    expect(xml).toContain(`<m:ListOrders xmlns:m="${NS}"><m:customerNo>C1&lt;/m:customerNo&gt;&lt;m:customerNo&gt;C2</m:customerNo><m:status>open &amp; &lt;shut&gt;</m:status></m:ListOrders>`);
    expect(xml).not.toContain('notInTheDescription');
    // A schema that does not qualify its children: they go without the prefix.
    const [, plain] = parseWsdl(WSDL('https://erp.acme.test/soap', `<types>${SCHEMA(false)}</types>`));
    expect(soapEnvelope(plain!, { customerNo: 'C1' })).toContain(`<m:ListOrders xmlns:m="${NS}"><customerNo>C1</customerNo></m:ListOrders>`);
    expect(soapEnvelope(orders!, { customerNo: 'C1' }, { username: 'forms', password: 'p<w' })).toContain('<o:Username>forms</o:Username><o:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">p&lt;w</o:Password>');
  });

  it('gives its rows, whether the answer holds a list, one thing, or nothing; a fault is an error in the service\'s words', () => {
    const wrap = (inner: string) => `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;
    expect(soapRows(wrap(`<n:R xmlns:n="${NS}"><n:orders><n:order><n:item>Cotton</n:item><n:qty>40</n:qty></n:order><n:order><n:item>Silk</n:item><n:qty>5</n:qty></n:order></n:orders></n:R>`))).toEqual([{ item: 'Cotton', qty: 40 }, { item: 'Silk', qty: 5 }]);
    expect(soapRows(wrap('<R><orders><order><item>Only one</item><qty>1</qty></order></orders></R>'))).toEqual([{ item: 'Only one', qty: 1 }]);
    // A code with leading zeros stays the text it is.
    expect(soapRows(wrap('<R><customer><no>007</no><name>Asha</name></customer></R>'))).toEqual([{ no: '007', name: 'Asha' }]);
    // Text comes back as it was meant; an entity the document makes up for itself is left alone, never expanded.
    expect(soapRows(wrap('<R><c><name>Bond &amp; Sons &lt;UK&gt; &#169; &#x263A;</name></c></R>'))).toEqual([{ name: 'Bond & Sons <UK> © ☺' }]);
    expect(soapRows(`<!DOCTYPE x [<!ENTITY big "aaaaaaaaaa">]>${wrap('<R><c><name>&big;&big;</name></c></R>')}`)).toEqual([{ name: '&big;&big;' }]);
    expect(soapRows(wrap('<R></R>'))).toEqual([]);
    expect(() => soapRows(wrap('<soap:Fault><faultcode>soap:Client</faultcode><faultstring>No such customer</faultstring></soap:Fault>'))).toThrow('The service refused the call: No such customer');
    expect(() => soapRows('<html>Gateway timeout</html>')).toThrow('did not answer with a SOAP message');
  });
});

/** A real SOAP service, run by a SOAP library that shares no code with the connector. */
describe('SOAP connector (against a real SOAP server)', () => {
  let server: Server;
  let base: string;
  const seen: { operation: string; args: Record<string, unknown> }[] = [];
  const reg = defaultRegistry();
  const limits = { timeoutMs: 8000, maxRows: 100 };
  const record = (settings: ConnectorRecord['settings'], writable = true): ConnectorRecord => ({ id: `c-soap-${JSON.stringify(settings).length}`, orgId: 'o1', type: 'soap', name: 'ERP', settings, secretRef: 'x', writable });
  const ctx = (settings: ConnectorRecord['settings'] = {}, secrets: Record<string, string> = {}, writable = true) => ({ connector: record({ wsdlUrl: `${base}/customers?wsdl`, ...settings }, writable), secrets, allowPrivateNetwork: true });
  const run = (req: Omit<OperationRequest, 'limits'>, c = ctx()) => reg.run(c, { ...req, limits });
  const signal = () => new AbortController().signal;

  beforeAll(async () => {
    const customers: Record<string, object> = { C1: { no: 'C1', name: 'Asha Textiles', city: 'Pune', credit: 5000.5 }, '007': { no: '007', name: 'Bond & Sons', city: 'London' } };
    const service = {
      CustomerService: {
        CustomerPort: {
          GetCustomer: (args: { no: string }) => {
            seen.push({ operation: 'GetCustomer', args });
            return customers[args.no] ? { customer: customers[args.no] } : {};
          },
          ListOrders: (args: { customerNo: string; status?: string }) => {
            seen.push({ operation: 'ListOrders', args });
            const all = args.customerNo === 'C1' ? [{ item: 'Cotton', qty: 40, status: 'open' }, { item: 'Silk', qty: 5, status: 'shipped' }] : [];
            return { orders: { order: all.filter((o) => !args.status || o.status === args.status).map(({ item, qty }) => ({ item, qty })) } };
          },
          AddComplaint: (args: { customerNo: string; text: string; urgent?: boolean }) => {
            seen.push({ operation: 'AddComplaint', args });
            if (!customers[args.customerNo]) throw { Fault: { faultcode: 'soap:Client', faultstring: 'No such customer' } };
            return { id: `CMP-${seen.filter((s) => s.operation === 'AddComplaint').length}` };
          },
        },
      },
    };
    server = createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    soap.listen(server, '/customers', service, WSDL(`${base}/customers`));
    // The same service behind a user name and password.
    const guarded = soap.listen(server, '/guarded', service, WSDL(`${base}/guarded`));
    guarded.authenticate = (security: { UsernameToken?: { Username?: string; Password?: { $value?: string } | string } }) => {
      const token = security?.UsernameToken;
      const password = typeof token?.Password === 'object' ? token.Password.$value : token?.Password;
      return token?.Username === 'forms' && password === 's3cret';
    };
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('reads the service\'s own description, and offers each operation with what it takes and returns', async () => {
    expect(await reg.get('soap').test({ ...ctx(), signal: signal() })).toMatchObject({ ok: true, message: "Read the service's description: 3 operations" });
    const found = await reg.get('soap').discover({ ...ctx(), signal: signal() });
    expect(found.map((e) => e.key)).toEqual(['GetCustomer', 'ListOrders', 'AddComplaint']);
    expect(found[0]!.fields.map((f) => f.name)).toEqual(['no', 'name', 'city', 'credit']);
    expect(found[1]!.fields.map((f) => f.name)).toEqual(['customerNo', 'status', 'item', 'qty']);
  });

  it('looks one thing up, lists many, and keeps a code with leading zeros as it is', async () => {
    const customer = { key: 'GetCustomer', fields: ['no', 'name', 'city'], keyField: 'no' };
    // Only the exposed fields come back: the credit limit is not one of them.
    expect((await run({ entity: customer, kind: 'get', params: { no: 'C1' } })).rows).toEqual([{ no: 'C1', name: 'Asha Textiles', city: 'Pune' }]);
    expect((await run({ entity: customer, kind: 'list', params: { no: '007' } })).rows).toEqual([{ no: '007', name: 'Bond & Sons', city: 'London' }]);
    expect((await run({ entity: customer, kind: 'lookup', params: { no: 'C1' } })).rows).toEqual([{ exists: true }]);
    expect((await run({ entity: customer, kind: 'lookup', params: { no: 'nobody' } })).rows).toEqual([]);

    const orders = { key: 'ListOrders', fields: ['customerNo', 'status', 'item', 'qty'] };
    expect((await run({ entity: orders, kind: 'list', params: { customerNo: 'C1' } })).rows).toEqual([{ item: 'Cotton', qty: 40 }, { item: 'Silk', qty: 5 }]);
    expect((await run({ entity: orders, kind: 'list', params: { customerNo: 'C1', status: 'open' } })).rows).toEqual([{ item: 'Cotton', qty: 40 }]);
    expect((await run({ entity: orders, kind: 'list', params: { customerNo: 'C9' } })).rows).toEqual([]);
    // What was typed reached the service as a value, markup and all.
    await run({ entity: orders, kind: 'list', params: { customerNo: 'C1</customerNo><status>x' } });
    expect(seen.at(-1)).toEqual({ operation: 'ListOrders', args: { customerNo: 'C1</customerNo><status>x' } });
  });

  it('sends values to an operation, only the exposed ones, and only when the connector may write', async () => {
    const add = { key: 'AddComplaint', fields: ['customerNo', 'text'] };
    const sent = await run({ entity: add, kind: 'insert', params: { customerNo: 'C1', text: 'Late <again> & again', urgent: true } });
    expect(sent).toMatchObject({ rows: [{ id: 'CMP-1' }], affected: 1 });
    // "urgent" is not exposed, so it was not sent.
    expect(seen.at(-1)).toEqual({ operation: 'AddComplaint', args: { customerNo: 'C1', text: 'Late <again> & again' } });
    await expect(run({ entity: add, kind: 'insert', params: { customerNo: 'C1', text: 'x' } }, ctx({}, {}, false))).rejects.toThrow('read-only');
    // The service's own refusal is passed on in its words.
    await expect(run({ entity: add, kind: 'insert', params: { customerNo: 'C404', text: 'x' } })).rejects.toThrow('The service refused the call: No such customer');
  });

  it('signs in with a WS-Security user name and password, and is refused without them', async () => {
    const customer = { key: 'GetCustomer', fields: ['no', 'name'], keyField: 'no' };
    const guarded = (auth: string, secrets: Record<string, string>) => ({ connector: record({ wsdlUrl: `${base}/guarded?wsdl`, auth }), secrets, allowPrivateNetwork: true });
    expect((await run({ entity: customer, kind: 'get', params: { no: 'C1' } }, guarded('wsse', { username: 'forms', password: 's3cret' }))).rows).toEqual([{ no: 'C1', name: 'Asha Textiles' }]);
    await expect(run({ entity: customer, kind: 'get', params: { no: 'C1' } }, guarded('wsse', { username: 'forms', password: 'wrong' }))).rejects.toThrow();
    await expect(run({ entity: customer, kind: 'get', params: { no: 'C1' } }, guarded('none', {}))).rejects.toThrow();
  });

  it('outside development the description and the service must be public and https', async () => {
    await expect(reg.run({ connector: record({ wsdlUrl: `${base}/customers?wsdl`, x: 1 }), secrets: {} }, { entity: { key: 'GetCustomer', fields: ['no'] }, kind: 'list', params: {}, limits })).rejects.toThrow();
  });
});
