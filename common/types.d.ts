// Message sent to start a server
declare interface Message {
    name: string,
    index: number,
    config: {
        myId: string,
        index: number
        server: object,
        infra: object,
    }
}

