import socket, ssl, threading, sys, os, re

LISTEN = ("127.0.0.1", 1413)
TARGET_HOST = "daily-cloudcode-pa.googleapis.com"
OUT = r"C:\Users\RYZEN\agy-proxy\capture.log"
CERT = r"C:\Users\RYZEN\agy-proxy\certs\fullchain.pem"
KEY  = r"C:\Users\RYZEN\agy-proxy\certs\privkey.pem"

def log(*a):
    with open(OUT,"a",encoding="utf-8",errors="replace") as f:
        f.write(" ".join(str(x) for x in a)+"\n\n")

def pipe(a,b,tag):
    try:
        while True:
            d=a.recv(65536)
            if not d: break
            log("=== %s ===\n"%tag, d.decode("utf-8","replace"))
            b.sendall(d)
    except Exception as e:
        log("[pipe err %s]"%tag, e)
    try: b.shutdown(socket.SHUT_WR)
    except Exception: pass

def handle(c):
    try:
        c.settimeout(10)
        data=c.recv(8192)
        if not data: return c.close()
        first=data.split(b"\r\n",1)[0].decode("latin1")
        if first.startswith("CONNECT"):
            host=first.split()[1]
            c.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            if TARGET_HOST in host:
                ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                ctx.load_cert_chain(CERT,KEY)
                try: c=ctx.wrap_socket(c,server_side=True)
                except Exception as e:
                    log("[TLS wrap fail]",e); return
                data=c.recv(65536)
                if not data: return
            else:
                up=ssl.create_default_context().wrap_socket(socket.create_connection((host,443)),server_hostname=host)
                up.sendall(data)
                threading.Thread(target=pipe,args=(up,c,"DOWN"),daemon=True).start()
                pipe(c,up,"UP"); return
        m=re.match(rb"[A-Z]+ (http://[^\s]+) ",data)
        if m:
            from urllib.parse import urlparse
            u=urlparse(m.group(1).decode())
            host=u.hostname
            data=data.replace(("http://%s"%host).encode(),b"",1)
        else:
            host=(re.search(rb"Host: ([^\r\n]+)",data).group(1).decode() if re.search(rb"Host: ([^\r\n]+)",data) else None)
        log("=== PLAIN REQ to %s ===\n"%host, data.decode("utf-8","replace"))
        up=socket.create_connection((host,443))
        up=ssl.create_default_context().wrap_socket(up,server_hostname=host)
        up.sendall(data)
        threading.Thread(target=pipe,args=(up,c,"DOWN"),daemon=True).start()
        pipe(c,up,"UP")
    except Exception as e:
        log("[handle err]",repr(e))
    try: c.close()
    except Exception: pass

s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(LISTEN); s.listen(64)
log("### sniffer listening",LISTEN)
while True:
    c,_=s.accept()
    threading.Thread(target=handle,args=(c,),daemon=True).start()
